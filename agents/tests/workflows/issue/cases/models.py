import re
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, field_validator

FindingVerdict = Literal["confirmed-defect", "confirmed-vulnerability"]


class IssueInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1)
    body: str = Field(min_length=1)


class EvidenceRequirement(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str = Field(min_length=1)
    any_of: list[str] = Field(min_length=1)

    @field_validator("any_of")
    @classmethod
    def validate_patterns(cls, values: list[str]) -> list[str]:
        for value in values:
            if not value.strip():
                raise ValueError("evidence patterns must not be blank")
            try:
                re.compile(value)
            except re.error as exc:
                raise ValueError(f"invalid evidence regex: {value!r}") from exc
        return values


class IssueCaseOracle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    acceptable_verdicts: set[FindingVerdict] = Field(min_length=1)
    mechanism: str = Field(min_length=1)
    required_evidence: list[EvidenceRequirement] = Field(min_length=1)
    required_locations: list[str] = Field(min_length=1)

    @field_validator("required_locations")
    @classmethod
    def validate_locations(cls, values: list[str]) -> list[str]:
        for value in values:
            path = Path(value)
            if path.is_absolute() or ".." in path.parts or path.name == "":
                raise ValueError(
                    "required locations must be repository-relative file paths"
                )
        return values


class IssueCase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    issue: IssueInput
    oracle: IssueCaseOracle

    _directory: Path = PrivateAttr()

    @field_validator("id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", value):
            raise ValueError("must use lowercase kebab-case")
        return value

    @property
    def workspace_source(self) -> Path:
        return self._directory / "workspace"

    def load_workspace_files(self) -> dict[str, str]:
        return {
            str(path.relative_to(self.workspace_source)): path.read_text(
                encoding="utf-8"
            )
            for path in sorted(self.workspace_source.rglob("*"))
            if path.is_file()
        }
