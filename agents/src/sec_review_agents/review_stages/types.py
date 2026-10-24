from typing import Literal, get_args

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


def literal_values(literal: object) -> tuple[str, ...]:
    return get_args(literal)
