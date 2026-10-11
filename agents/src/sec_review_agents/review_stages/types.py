from typing import Literal

Verdict = Literal[
    "no-actionable-finding",
    "inconclusive",
    "plausible-risk",
    "confirmed-defect",
    "confirmed-vulnerability",
]
ValidationLevel = Literal[
    "static", "logic-simulated", "runtime-partial", "runtime-endpoint"
]
RegressionStatus = Literal[
    "passed", "failed", "not-run", "not-applicable", "unresolved"
]
PatchCoverage = Literal[
    "full",
    "partial",
    "local-only",
    "unresolved",
    "misaligned",
    "no-patch",
    "not-applicable",
]
ResolutionNextStep = Literal["none", "retry-ai", "manual-review"]
CvssOutcome = Literal["scored", "not-scored", "skipped"]

# Runtime projection allowlists for the public review-record contract.
# Keep these in sync with the aliases above whenever adding or removing a
# public enum value; unknown upstream values are intentionally projected as None.
VERDICT_VALUES: tuple[Verdict, ...] = (
    "no-actionable-finding",
    "inconclusive",
    "plausible-risk",
    "confirmed-defect",
    "confirmed-vulnerability",
)
VALIDATION_LEVEL_VALUES: tuple[ValidationLevel, ...] = (
    "static",
    "logic-simulated",
    "runtime-partial",
    "runtime-endpoint",
)
REGRESSION_STATUS_VALUES: tuple[RegressionStatus, ...] = (
    "passed",
    "failed",
    "not-run",
    "not-applicable",
    "unresolved",
)
PATCH_COVERAGE_VALUES: tuple[PatchCoverage, ...] = (
    "full",
    "partial",
    "local-only",
    "unresolved",
    "misaligned",
    "no-patch",
    "not-applicable",
)
RESOLUTION_NEXT_STEP_VALUES: tuple[ResolutionNextStep, ...] = (
    "none",
    "retry-ai",
    "manual-review",
)
CVSS_OUTCOME_VALUES: tuple[CvssOutcome, ...] = (
    "scored",
    "not-scored",
    "skipped",
)
