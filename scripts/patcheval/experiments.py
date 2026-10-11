"""The PatchEval experiment matrix.

This module is the source for which experiments exist, what each one means, and which run
the workflow versus being derived from another run's artifacts. The shell drivers print
the executable names with ``python -m scripts.patcheval.experiments`` rather than
restating the matrix.
"""

from dataclasses import dataclass
from typing import Literal

IssueStrategy = Literal["default", "two-stage", "single-agent"]


@dataclass(frozen=True)
class ExperimentSpec:
    """One PatchEval experiment.

    ``derived_from`` is set for an evaluation-only view that reuses another experiment's
    artifacts instead of running the workflow again.
    """

    name: str
    issue_strategy: IssueStrategy
    location_oracle: bool
    derived_from: str | None = None


# Evaluation order; a derived view follows the run it is derived from.
EXPERIMENTS: tuple[ExperimentSpec, ...] = (
    ExperimentSpec("end-to-end-default", "default", False),
    ExperimentSpec(
        "end-to-end-lightweight-two-stage",
        "two-stage",
        False,
        derived_from="end-to-end-default",
    ),
    ExperimentSpec("end-to-end-single-agent", "single-agent", False),
    ExperimentSpec("end-to-end-two-stage", "two-stage", False),
    ExperimentSpec("location-oracle-default", "default", True),
    ExperimentSpec(
        "location-oracle-lightweight-two-stage",
        "two-stage",
        True,
        derived_from="location-oracle-default",
    ),
    ExperimentSpec("location-oracle-single-agent", "single-agent", True),
    ExperimentSpec("location-oracle-two-stage", "two-stage", True),
)

EVALUATION_EXPERIMENTS: tuple[str, ...] = tuple(spec.name for spec in EXPERIMENTS)

# The experiments a driver can execute: everything that is not derived from another run.
EXECUTED_EXPERIMENTS: tuple[str, ...] = tuple(
    spec.name for spec in EXPERIMENTS if spec.derived_from is None
)

# The same executed experiments keyed by name, for resolving a `--variant` selection.
EXECUTED_EXPERIMENTS_BY_NAME: dict[str, ExperimentSpec] = {
    spec.name: spec for spec in EXPERIMENTS if spec.derived_from is None
}

LIGHTWEIGHT_COST_VARIANTS: dict[str, str] = {
    spec.derived_from: spec.name
    for spec in EXPERIMENTS
    if spec.derived_from is not None
}


def main() -> None:
    """Print the executable experiment names, one per line, for the shell drivers."""
    for name in EXECUTED_EXPERIMENTS:
        print(name)


if __name__ == "__main__":
    main()
