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


class CommandArgumentOracle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    crosses_security_boundary: bool
    attacker_controlled_argument: str


class SkillCaseOracles(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: DecisionOracle | None = None
    classification: ClassificationOracle | None = None
    command_argument: CommandArgumentOracle | None = None

    @model_validator(mode="after")
    def validate_output_shape(self) -> SkillCaseOracles:
        specialized = sum(
            oracle is not None
            for oracle in (self.classification, self.command_argument)
        )
        if specialized > 1:
            raise ValueError("a case may define only one specialized output oracle")
        if specialized and self.decision is None:
            raise ValueError("specialized output oracles require a decision oracle")
        return self


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


class SkillReadOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    skill_path_read: str | None = None
    reference_path_read: str | None = None


class DecisionOutput(SkillReadOutput):
    verdict: SkillVerdict = Field(
        description=(
            "Use confirmed when the security failure and impact are established, "
            "rejected when known facts break the claimed security relation, and "
            "unresolved when material facts needed for the decision are unavailable."
        )
    )
    evidence: str
    rationale: str
    proof_gaps: list[str] = Field(
        default_factory=list,
        description=(
            "Material missing facts that prevent a confirmed or rejected decision. "
            "Populate for unresolved and leave empty otherwise."
        ),
    )


class ClassificationOutput(DecisionOutput):
    cwe_id: str
    cwe_name: str = ""
    parent_category_id: str | None = None
    parent_category_name: str = ""


class CommandArgumentOutput(DecisionOutput):
    attacker_controlled_argument: str = Field(
        description=(
            "The exact single caller-controlled argument value that changes the "
            "child parser's behavior, not the complete argv list."
        ),
    )
    crosses_security_boundary: bool


type SkillCaseOutput = (
    SkillReadOutput | DecisionOutput | ClassificationOutput | CommandArgumentOutput
)


def output_model_for_case(
    case: SkillCase,
) -> type[SkillReadOutput]:
    if case.oracles.command_argument is not None:
        return CommandArgumentOutput
    if case.oracles.classification is not None:
        return ClassificationOutput
    if case.oracles.decision is not None:
        return DecisionOutput
    return SkillReadOutput
