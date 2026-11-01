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
