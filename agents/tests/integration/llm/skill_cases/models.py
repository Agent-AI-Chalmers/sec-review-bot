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

SkillCaseMode = Literal["prompted", "discovery", "contrast"]
SkillVerdict = Literal["confirmed", "rejected", "unresolved"]


class DecisionOracle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    verdict: SkillVerdict
    explanation_requirements: list[str] = Field(min_length=2)
    proof_gap_requirements: list[str] = Field(default_factory=list)

    @field_validator("explanation_requirements", "proof_gap_requirements")
    @classmethod
    def validate_requirements(cls, values: list[str]) -> list[str]:
        if len(values) == 1:
            raise ValueError(
                "must contain zero or at least two independent requirements"
            )
        for value in values:
            if not value.strip():
                raise ValueError("requirements must not be blank")
            try:
                re.compile(value)
            except re.error as exc:
                raise ValueError(f"invalid requirement regex: {value!r}") from exc
        return values

    @model_validator(mode="after")
    def validate_proof_gap_semantics(self) -> DecisionOracle:
        if self.verdict == "unresolved" and len(self.proof_gap_requirements) < 2:
            raise ValueError(
                "unresolved decisions require at least two material proof gaps"
            )
        if self.verdict != "unresolved" and self.proof_gap_requirements:
            raise ValueError(
                "only unresolved decisions may define proof-gap requirements"
            )
        return self


class ClassificationOracle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cwe_id: str
    parent_category_id: str | None = None


class ExactOutputOracle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    crosses_security_boundary: bool | None = None
    attacker_controlled_argument: str | None = None


class SkillCaseOracles(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: DecisionOracle | None = None
    classification: ClassificationOracle | None = None
    exact_output: ExactOutputOracle | None = None


class SkillCase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1]
    id: str
    skill: str
    reference: str
    modes: set[SkillCaseMode] = Field(min_length=1)
    task: str
    facts: list[str] = Field(min_length=1)
    oracles: SkillCaseOracles = Field(default_factory=SkillCaseOracles)

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
    verdict: SkillVerdict = Field(
        description=(
            "Use confirmed when the security failure and impact are established, "
            "rejected when known facts break the claimed security relation, and "
            "unresolved when material facts needed for the decision are unavailable."
        )
    )
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
    proof_gaps: list[str] = Field(
        default_factory=list,
        description=(
            "Material missing facts that prevent a confirmed or rejected decision. "
            "Populate for unresolved and leave empty otherwise."
        ),
    )
    cwe_id: str | None = None
    cwe_name: str | None = None
    parent_category_id: str | None = None
    parent_category_name: str | None = None
