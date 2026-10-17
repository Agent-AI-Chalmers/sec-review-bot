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

McpName = Literal["codegraph", "playwright"]
McpCaseMode = Literal["capability", "discovery", "compare"]
McpCapabilityProbe = Literal[
    "codegraph-cross-file-call",
    "playwright-browser-sink-effect",
]


class McpCapabilityCase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    probe: McpCapabilityProbe
    expected_marker: str
    target_url: str | None = None

    @field_validator("expected_marker")
    @classmethod
    def validate_expected_marker(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value

    @model_validator(mode="after")
    def validate_target_url(self) -> McpCapabilityCase:
        needs_target = self.probe.startswith("playwright-")
        if needs_target != (self.target_url is not None):
            requirement = "requires" if needs_target else "does not accept"
            raise ValueError(f"probe {self.probe!r} {requirement} target_url")
        return self


class McpToolInteractionOracle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tool: str
    arguments_pattern: str
    result_pattern: str

    @field_validator("tool", "arguments_pattern", "result_pattern")
    @classmethod
    def validate_nonblank_value(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value

    @field_validator("arguments_pattern", "result_pattern")
    @classmethod
    def validate_pattern(cls, value: str) -> str:
        try:
            re.compile(value)
        except re.error as exc:
            raise ValueError(f"invalid interaction regex: {value!r}") from exc
        return value


class McpCaseOracle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    validation_level: str
    required_tool_interactions: list[McpToolInteractionOracle] = Field(min_length=1)
    forbidden_tool_error_prefixes: list[str] = Field(default_factory=list)
    without_mcp_forbidden_tool_prefixes: list[str] = Field(default_factory=list)
    without_mcp_forbidden_validation_levels: list[str] = Field(default_factory=list)
    result_requirements: list[str] = Field(min_length=1)

    @field_validator(
        "forbidden_tool_error_prefixes",
        "without_mcp_forbidden_tool_prefixes",
        "without_mcp_forbidden_validation_levels",
        "result_requirements",
    )
    @classmethod
    def validate_nonblank_values(cls, values: list[str]) -> list[str]:
        if any(not value.strip() for value in values):
            raise ValueError("values must not be blank")
        return values

    @field_validator("result_requirements")
    @classmethod
    def validate_result_patterns(cls, values: list[str]) -> list[str]:
        for value in values:
            try:
                re.compile(value)
            except re.error as exc:
                raise ValueError(
                    f"invalid result requirement regex: {value!r}"
                ) from exc
        return values


class McpAgentCase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    review_input: str
    analysis_overview: str
    oracles: McpCaseOracle

    @field_validator("review_input", "analysis_overview")
    @classmethod
    def validate_nonblank_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value


class McpCase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    mcp: McpName
    modes: set[McpCaseMode] = Field(min_length=1)
    setup_file: str | None = None
    capability: McpCapabilityCase | None = None
    discovery: McpAgentCase | None = None
    compare: McpAgentCase | None = None

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
    def validate_mode_configuration(self) -> McpCase:
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
        if self.capability is not None:
            probe_mcp = self.capability.probe.split("-", maxsplit=1)[0]
            if probe_mcp != self.mcp:
                raise ValueError(
                    f"capability probe {self.capability.probe!r} does not match "
                    f"MCP {self.mcp!r}"
                )
        return self

    def agent_case_for(self, mode: Literal["discovery", "compare"]) -> McpAgentCase:
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
