import re
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, field_validator

McpCaseMode = Literal["discovery", "compare"]


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


class McpCase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    modes: set[McpCaseMode] = Field(min_length=1)
    review_input: str
    analysis_overview: str
    setup_file: str
    oracles: McpCaseOracle

    _directory: Path = PrivateAttr()

    @field_validator("id")
    @classmethod
    def validate_identifier(cls, value: str) -> str:
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", value):
            raise ValueError("must use lowercase kebab-case")
        return value

    @field_validator("setup_file")
    @classmethod
    def validate_setup_file(cls, value: str) -> str:
        if Path(value).name != value or Path(value).suffix not in {".yml", ".yaml"}:
            raise ValueError("must be one YAML filename")
        return value

    @property
    def directory(self) -> Path:
        return self._directory

    @property
    def workspace_source(self) -> Path:
        return self.directory / "workspace"

    @property
    def setup_path(self) -> Path:
        return self.directory / self.setup_file
