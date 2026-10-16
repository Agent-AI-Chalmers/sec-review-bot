import re
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, field_validator

SkillCaseMode = Literal["prompted", "natural", "contrast"]
SkillVerdict = Literal["confirmed", "not-confirmed"]


class SkillCaseExpected(BaseModel):
    model_config = ConfigDict(extra="forbid")

    verdict: SkillVerdict
    crosses_security_boundary: bool | None = None
    attacker_controlled_argument: str | None = None
    require_proof_gaps: bool = False
    cwe_id: str | None = None
    parent_category_id: str | None = None
    explanation_pattern: str | None = None


class SkillCase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1]
    id: str
    skill: str
    reference: str
    modes: set[SkillCaseMode] = Field(min_length=1)
    task: str
    facts: list[str] = Field(min_length=1)
    expected: SkillCaseExpected

    _directory: Path = PrivateAttr()

    @field_validator("id", "skill")
    @classmethod
    def validate_identifier(cls, value: str) -> str:
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", value):
            raise ValueError("must use lowercase kebab-case")
        return value

    @field_validator("reference")
    @classmethod
    def validate_reference_name(cls, value: str) -> str:
        if Path(value).name != value or not value.endswith(".md"):
            raise ValueError("must be one Markdown filename")
        return value

    @property
    def directory(self) -> Path:
        return self._directory

    @property
    def workspace_source(self) -> Path:
        return self.directory / "workspace"

    @property
    def skill_path(self) -> str:
        return f"/skills/{self.skill}/SKILL.md"

    @property
    def reference_path(self) -> str:
        return f"/skills/{self.skill}/references/{self.reference}"


class SkillCaseOutput(BaseModel):
    verdict: SkillVerdict
    vulnerability_type: str = ""
    skill_path_read: str | None = None
    reference_path_read: str | None = None
    precedent_applied: str = ""
    attacker_controlled_argument: str | None = Field(
        default=None,
        description=(
            "The exact single caller-controlled argument value that changes the "
            "child parser's behavior, not the complete argv list."
        ),
    )
    crosses_security_boundary: bool | None = None
    evidence: str
    rationale: str
    proof_gaps: list[str] = Field(default_factory=list)
    cwe_id: str | None = None
    cwe_name: str | None = None
    parent_category_id: str | None = None
    parent_category_name: str | None = None
