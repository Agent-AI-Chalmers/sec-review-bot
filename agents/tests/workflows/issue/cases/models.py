import re
from pathlib import Path
from typing import Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    PrivateAttr,
    field_validator,
    model_validator,
)

FindingVerdict = Literal["confirmed-defect", "confirmed-vulnerability"]


def _validate_repository_paths(values: list[str]) -> list[str]:
    for value in values:
        path = Path(value)
        if path.is_absolute() or ".." in path.parts or path.name == "":
            raise ValueError(
                "required locations must be repository-relative file paths"
            )
    return values


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


class FindingRequirement(BaseModel):
    """One confirmed finding the run must produce, matched independently of the others.

    `required_evidence` describes evidence a single accepted finding must carry. Some issues
    instead contain several independently actionable defects. Merging them into one finding is the
    regression those cases exist to catch, so each entry here must be satisfied by its own
    finding: one combined narrative cannot satisfy two requirements.
    """

    model_config = ConfigDict(extra="forbid")

    label: str = Field(min_length=1)
    required_evidence: list[EvidenceRequirement] = Field(min_length=1)
    required_locations: list[str] = Field(default_factory=list)

    @field_validator("required_locations")
    @classmethod
    def validate_locations(cls, values: list[str]) -> list[str]:
        return _validate_repository_paths(values)


class IssueCaseOracle(BaseModel):
    """What a passing run looks like, expressed so the runner stays generic.

    `required_evidence` and `required_locations` describe the shape of one accepted finding; they
    apply to every finding the oracle accepts. `required_findings` additionally requires several
    distinct findings, one per entry.
    """

    model_config = ConfigDict(extra="forbid")

    acceptable_verdicts: set[FindingVerdict] = Field(min_length=1)
    # Human-review reference recorded in artifacts; automated scoring uses the
    # structured evidence and location requirements below.
    expected_mechanism: str = Field(min_length=1)
    required_evidence: list[EvidenceRequirement] = Field(default_factory=list)
    required_locations: list[str] = Field(default_factory=list)
    required_findings: list[FindingRequirement] = Field(default_factory=list)

    @field_validator("required_locations")
    @classmethod
    def validate_locations(cls, values: list[str]) -> list[str]:
        return _validate_repository_paths(values)

    @model_validator(mode="after")
    def validate_has_requirement(self) -> IssueCaseOracle:
        if not self.required_evidence and not self.required_findings:
            raise ValueError(
                "an issue case oracle needs required_evidence or required_findings"
            )
        return self

    def all_locations(self) -> list[str]:
        """Every file path the oracle names, including those of individual findings."""
        locations = list(self.required_locations)
        for requirement in self.required_findings:
            locations.extend(requirement.required_locations)
        return locations


class CaseExpectation(BaseModel):
    """One worked example of what the oracle should do with a result.

    `accepted` requires at least one finding to satisfy the oracle; `rejected` requires none to.
    The issue oracle has no third outcome: it never fails a run for a finding that merely appears,
    so unlike the pull request oracle there is no `forbidden` verdict to express.
    """

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1)
    expected: Literal["accepted", "rejected"]
    result: dict[str, Any]


class IssueCaseExpectations(BaseModel):
    model_config = ConfigDict(extra="forbid")

    examples: list[CaseExpectation] = Field(min_length=1)


class IssueCase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    issue: IssueInput
    oracle: IssueCaseOracle

    _directory: Path = PrivateAttr()
    _expectations: list[CaseExpectation] = PrivateAttr(default_factory=list)

    @field_validator("id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", value):
            raise ValueError("must use lowercase kebab-case")
        return value

    @property
    def expectations(self) -> list[CaseExpectation]:
        """Worked examples of this case's oracle, kept beside the oracle they describe."""
        return self._expectations

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
