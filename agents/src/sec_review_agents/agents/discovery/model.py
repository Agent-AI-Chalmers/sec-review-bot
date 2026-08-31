from pydantic import BaseModel, Field


class DiscoveryLocation(BaseModel):
    """
    Anchor one discovery signal in one file from the current scan chunk.
    Keep `label` short and specific to why this line matters.
    """

    file: str = Field(
        min_length=1,
        description="Repository-relative file path for this anchor.",
    )
    line: int | None = Field(
        default=None,
        ge=1,
        description=(
            "Optional 1-based line number in the referenced file where the signal is "
            "anchored. Omit when the anchor is file-level."
        ),
    )
    label: str = Field(
        max_length=120,
        description="Short anchor label describing why this line is relevant.",
    )


class DiscoveryCandidate(BaseModel):
    """
    Keep `category`, `description`, `locations`, and `evidence` aligned to one chunk-scoped security candidate.
    Always provide at least one real anchor in `locations` and at least one supporting snippet in `evidence`.
    Keep `description` evidence-based and specific enough to state the security risk, without claiming impact that the
    cited chunk evidence does not support.
    """

    category: str = Field(
        description="Broad risk class label used for triage grouping."
    )
    description: str = Field(
        min_length=1,
        description="Concise security risk description grounded in the scanned files.",
    )
    locations: list[DiscoveryLocation] = Field(
        min_length=1,
        description="At least one anchored source location for this finding in the scanned files.",
    )
    evidence: list[str] = Field(
        min_length=1,
        description="At least one verbatim snippet from the scanned files supporting the finding.",
    )


class DiscoveryOutput(BaseModel):
    """
    Return only chunk-scoped discovery candidates for the current scan unit.
    Keep the list concise and grounded; omit unsupported candidates instead of padding output volume.
    """

    candidates: list[DiscoveryCandidate] = Field(
        default_factory=list,
        description="Chunk-scoped security discovery candidates.",
    )
