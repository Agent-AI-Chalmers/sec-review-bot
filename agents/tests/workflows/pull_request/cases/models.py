import re
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, field_validator


def _validate_patterns(values: list[str]) -> list[str]:
    """Reject blank or uncompilable patterns while the case file is read.

    The runner consumes these with re.search, so a malformed pattern would otherwise surface only
    when a narrative is evaluated -- after a model call in the real-LLM probe, which is the most
    expensive place to discover a typo. Compiling here turns it into a fixture error.
    """
    for value in values:
        if not value.strip():
            raise ValueError("narrative pattern must not be blank")
        try:
            re.compile(value)
        except re.error as exc:
            raise ValueError(f"invalid narrative pattern {value!r}: {exc}") from exc
    return values


class PullRequestSubject(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1)
    body: str = Field(min_length=1)
    base_ref: str = Field(min_length=1)
    head_ref: str = Field(min_length=1)


class DeclaredChangedFile(BaseModel):
    """One entry of the materialized changed-files.json.

    The loader checks each path exists in the case workspace, so a fixture cannot claim a file the
    tree does not contain. Counts are what a producer reports for the window and are not derived
    here: a fixture whose counts disagree with the tree would describe a different change.
    """

    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1)
    status: str = Field(min_length=1)
    additions: int = Field(ge=0)
    deletions: int = Field(ge=0)

    @field_validator("path")
    @classmethod
    def validate_path(cls, value: str) -> str:
        if value.startswith("/") or ".." in Path(value).parts:
            raise ValueError(f"changed file path must be workspace-relative: {value!r}")
        return value


class NarrativeRequirement(BaseModel):
    """Text an accepted narrative must match, written as case data rather than runner code.

    A requirement holds when at least one of its patterns matches the rendered narrative.
    """

    model_config = ConfigDict(extra="forbid")

    label: str = Field(min_length=1)
    any_of: list[str] = Field(min_length=1)

    @field_validator("any_of")
    @classmethod
    def validate_patterns(cls, values: list[str]) -> list[str]:
        return _validate_patterns(values)


class ForbiddenNarrative(BaseModel):
    """A narrative shape that disqualifies a run, expressed as a conjunction.

    A false positive is rarely one keyword. In this case it is "leans on the client check, never
    reaches the server endpoint, and anchors only in the client file" -- a correct narrative
    mentions the client check too, so matching keywords alone would forbid the right answer. Every
    field that is set must hold for the narrative to count as forbidden.

    `all`, `any_of`, and `none_of` are regular expressions matched against the rendered narrative,
    the same as the required ones, so a case file never has to guess which rule a pattern follows.
    `files_only` is different: it lists literal paths compared against the narrative's locations.
    """

    model_config = ConfigDict(extra="forbid")

    label: str = Field(min_length=1)
    # Every pattern must appear in the rendered narrative.
    all: list[str] = Field(default_factory=list)
    # At least one pattern must appear; empty means the field does not constrain.
    any_of: list[str] = Field(default_factory=list)
    # None of these patterns may appear. This is what separates "the client check is the boundary"
    # from "the client check is not the boundary": the second names the server evidence too.
    none_of: list[str] = Field(default_factory=list)
    # Every location the narrative anchors to must be one of these files.
    files_only: list[str] = Field(default_factory=list)

    @field_validator("all", "any_of", "none_of")
    @classmethod
    def validate_patterns(cls, values: list[str]) -> list[str]:
        return _validate_patterns(values)

    @field_validator("files_only")
    @classmethod
    def validate_files(cls, values: list[str]) -> list[str]:
        # These are literal paths compared against a narrative's locations, not patterns matched
        # against its text. A path such as "src/routes/(admin.ts" is a legal file name and an
        # invalid regular expression, so compiling it here would reject valid case data.
        for value in values:
            if not value.strip():
                raise ValueError("anchored file must not be blank")
            if value.startswith("/") or ".." in Path(value).parts:
                raise ValueError(f"anchored file must be workspace-relative: {value!r}")
        return values


class PullRequestCaseOracle(BaseModel):
    """What a passing run looks like, expressed so the runner stays generic.

    `required` lists text an accepted confirmed narrative must carry. `forbidden` lists shapes that
    disqualify a run: each is checked against every accepted-verdict narrative, because a false
    positive usually fails the requirements too, and filtering it out would let it pass silently.
    """

    model_config = ConfigDict(extra="forbid")

    acceptable_verdicts: list[str] = Field(
        default_factory=lambda: ["confirmed-vulnerability"]
    )
    required: list[NarrativeRequirement] = Field(min_length=1)
    forbidden: list[ForbiddenNarrative] = Field(default_factory=list)


class PullRequestCase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    # What the case guards, in one line, so a fixture explains itself without reading the test.
    description: str | None = None
    pull_request: PullRequestSubject
    changed_files: list[DeclaredChangedFile] = Field(min_length=1)
    oracle: PullRequestCaseOracle

    _directory: Path | None = PrivateAttr(default=None)
    _expectations: list[CaseExpectation] = PrivateAttr(default_factory=list)

    @property
    def workspace_source(self) -> Path:
        if self._directory is None:
            raise ValueError(
                f"case {self.id} has no directory; load it through the loader"
            )
        return self._directory / "workspace"

    @property
    def expectations(self) -> list[CaseExpectation]:
        """Worked examples of this case's contract, kept beside the oracle they describe."""
        return self._expectations


class CaseExpectation(BaseModel):
    """One worked example of what a run of this case should produce.

    `result` is the shape an analyzer returns, reduced to what the oracle reads. `expected` names
    the verdict: `accepted` requires at least one narrative to pass the oracle, `rejected` requires
    the oracle to accept none, and `forbidden` requires the oracle to fail because a disallowed
    narrative appears somewhere in the result. A case needing a fourth verdict signals that the
    oracle model is missing something, not that it needs a bespoke test.
    """

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1)
    expected: Literal["accepted", "rejected", "forbidden"]
    result: dict[str, Any]


class PullRequestCaseExpectations(BaseModel):
    model_config = ConfigDict(extra="forbid")

    examples: list[CaseExpectation] = Field(min_length=1)
