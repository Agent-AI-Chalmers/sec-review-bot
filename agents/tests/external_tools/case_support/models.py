import re
from pathlib import Path
from typing import Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    PrivateAttr,
    field_validator,
    model_validator,
)

ExternalToolName = Literal["joern", "playwright"]
ExternalToolCaseMode = Literal["capability", "discovery", "compare"]
ExternalToolCaseWorkflow = Literal["analysis", "verification"]
ExternalToolCapabilityProbe = Literal[
    "joern-cross-file-call",
    "joern-source-to-sink",
    "playwright-browser-state",
    "playwright-browser-sink-effect",
]


class GitCheckoutSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    repository: str
    commit: str

    @field_validator("repository", "commit")
    @classmethod
    def validate_nonblank_value(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value

    @field_validator("commit")
    @classmethod
    def validate_commit(cls, value: str) -> str:
        if not re.fullmatch(r"[0-9a-f]{40}", value):
            raise ValueError("must be a full 40-character lowercase commit hash")
        return value


class ExternalToolCapabilityCase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    probe: ExternalToolCapabilityProbe
    expected_marker: str
    target_url: str | None = None

    @field_validator("expected_marker")
    @classmethod
    def validate_expected_marker(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value

    @model_validator(mode="after")
    def validate_target_url(self) -> ExternalToolCapabilityCase:
        needs_target = self.probe.startswith("playwright-")
        if needs_target != (self.target_url is not None):
            requirement = "requires" if needs_target else "does not accept"
            raise ValueError(f"probe {self.probe!r} {requirement} target_url")
        return self


class ExternalToolInteractionOracle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    arguments_pattern: str
    result_pattern: str

    @field_validator("arguments_pattern", "result_pattern")
    @classmethod
    def validate_pattern(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        try:
            re.compile(value)
        except re.error as exc:
            raise ValueError(f"invalid interaction regex: {value!r}") from exc
        return value


class ExternalToolCaseOracle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    validation_level: str | None = None
    required_execute_interactions: list[ExternalToolInteractionOracle] = Field(
        min_length=1
    )
    result_requirements: list[str] = Field(min_length=1)
    comparison_evidence_patterns: list[str] = Field(default_factory=list)

    @field_validator("result_requirements", "comparison_evidence_patterns")
    @classmethod
    def validate_result_patterns(cls, values: list[str]) -> list[str]:
        for value in values:
            if not value.strip():
                raise ValueError("values must not be blank")
            try:
                re.compile(value)
            except re.error as exc:
                raise ValueError(f"invalid result regex: {value!r}") from exc
        return values


class ExternalToolAgentCase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    workflow: ExternalToolCaseWorkflow = "verification"
    review_input: str
    analysis_overview: str
    oracles: ExternalToolCaseOracle

    @field_validator("review_input", "analysis_overview")
    @classmethod
    def validate_nonblank_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value


class ExternalToolCase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    tool: ExternalToolName
    modes: set[ExternalToolCaseMode] = Field(min_length=1)
    setup_file: str | None = None
    checkout: GitCheckoutSource | None = None
    capability: ExternalToolCapabilityCase | None = None
    discovery: ExternalToolAgentCase | None = None
    compare: ExternalToolAgentCase | None = None

    _directory: Path = PrivateAttr()

    @field_validator("id")
    @classmethod
    def validate_identifier(cls, value: str) -> str:
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", value):
            raise ValueError("must use lowercase kebab-case")
        return value

    @field_validator("setup_file")
    @classmethod
    def validate_setup_file(cls, value: str | None) -> str | None:
        if value is not None and (
            Path(value).name != value or Path(value).suffix not in {".yml", ".yaml"}
        ):
            raise ValueError("must be one YAML filename")
        return value

    @model_validator(mode="after")
    def validate_mode_configuration(self) -> ExternalToolCase:
        configured_modes = {
            mode
            for mode in ("capability", "discovery", "compare")
            if getattr(self, mode) is not None
        }
        if configured_modes != self.modes:
            raise ValueError(
                f"modes {sorted(self.modes)!r} must match configured mode blocks "
                f"{sorted(configured_modes)!r}"
            )
        if (
            self.compare is not None
            and not self.compare.oracles.comparison_evidence_patterns
        ):
            raise ValueError("compare mode requires comparison_evidence_patterns")
        if self.capability is not None:
            probe_tool = self.capability.probe.split("-", maxsplit=1)[0]
            if probe_tool != self.tool:
                raise ValueError(
                    f"capability probe {self.capability.probe!r} does not match "
                    f"tool {self.tool!r}"
                )
            if self.checkout is not None:
                raise ValueError("capability mode requires a local workspace")
        return self

    def agent_case_for(
        self, mode: Literal["discovery", "compare"]
    ) -> ExternalToolAgentCase:
        agent_case = getattr(self, mode)
        if agent_case is None:
            raise ValueError(f"case {self.id!r} does not configure {mode!r} mode")
        return agent_case

    @property
    def directory(self) -> Path:
        return self._directory

    @property
    def workspace_source(self) -> Path:
        return self.directory / "workspace"

    @property
    def setup_path(self) -> Path | None:
        return self.directory / self.setup_file if self.setup_file else None
