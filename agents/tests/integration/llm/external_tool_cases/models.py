import re
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, field_validator

ExternalToolName = Literal["joern", "playwright"]


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

    validation_level: str
    required_execute_interactions: list[ExternalToolInteractionOracle] = Field(
        min_length=1
    )
    result_requirements: list[str] = Field(min_length=1)

    @field_validator("result_requirements")
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


class ExternalToolCase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    tool: ExternalToolName
    review_input: str
    analysis_overview: str
    setup_file: str | None = None
    oracles: ExternalToolCaseOracle

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

    @property
    def directory(self) -> Path:
        return self._directory

    @property
    def workspace_source(self) -> Path:
        return self.directory / "workspace"

    @property
    def setup_path(self) -> Path | None:
        return self.directory / self.setup_file if self.setup_file else None
