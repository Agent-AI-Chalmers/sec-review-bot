from collections.abc import Sequence
from typing import Annotated, Literal, Self

from pydantic import BaseModel, Field, model_validator

from sec_review_agents.utils.pydantic_types import NonEmptyText


# Length limits mirror the Memory Catalog MaintenanceReport contract so ToolStrategy
# asks the model to shorten output instead of the later HTTP reserve rejecting it.
class ObservationDecision(BaseModel):
    """
    Record what happened to one selected observation and why.
    The reason should justify the decision, such as why the lesson is durable, which existing guidance already covers it, or why it is too specific to one run; it should not restate the lesson itself.
    """

    observation_id: NonEmptyText = Field(
        description="Observation id of one selected observation, exactly as listed in the task."
    )
    action: Literal["added", "merged", "skipped", "conflict"] = Field(
        description=(
            "added: wrote new durable guidance; merged: folded into or refined existing guidance; "
            "skipped: kept nothing because the lesson is weak, one-run-only, or already covered; "
            "conflict: contradicts existing memory and was marked as unresolved."
        )
    )
    topics: list[Annotated[NonEmptyText, Field(max_length=512)]] = Field(
        max_length=64,
        description="Topic files under /memory/topics/ that this decision edited. Empty only for skipped.",
    )
    reason: NonEmptyText = Field(
        max_length=2000, description="One sentence justifying the decision."
    )

    @model_validator(mode="after")
    def require_topics_for_edits(self) -> Self:
        if self.action != "skipped" and not self.topics:
            raise ValueError(f"{self.action} decisions must name the edited topics")
        return self


class MemoryMaintenanceOutput(BaseModel):
    """
    Report the outcome of this maintenance pass after all file edits are complete.
    Give exactly one decision per selected observation, and none when no observations were selected.
    """

    observation_decisions: list[ObservationDecision] = Field(
        max_length=1000,
        description="One decision per selected observation.",
    )
    summary: NonEmptyText = Field(
        max_length=4000,
        description=(
            "Short account of what changed in the memory tree and why. "
            "If nothing changed, state what was reviewed and why no change was needed."
        ),
    )


# Build the completion schema per run so its validator can close over the
# selected observation ids. Under LangChain ToolStrategy a failure is returned to
# the model for retry; under ProviderStrategy it fails the run.
def memory_maintenance_output_model(
    observation_ids: Sequence[str],
) -> type[MemoryMaintenanceOutput]:
    expected = list(observation_ids)

    class MemoryMaintenanceRunOutput(MemoryMaintenanceOutput):
        __doc__ = MemoryMaintenanceOutput.__doc__

        @model_validator(mode="after")
        def require_one_decision_per_observation(self) -> Self:
            reported = [
                decision.observation_id for decision in self.observation_decisions
            ]
            duplicates = sorted({item for item in reported if reported.count(item) > 1})
            missing = [item for item in expected if item not in reported]
            unknown = sorted(set(reported) - set(expected))
            problems = [
                f"{label}: {', '.join(items)}"
                for label, items in (
                    ("duplicate", duplicates),
                    ("missing", missing),
                    ("unknown", unknown),
                )
                if items
            ]
            if problems:
                raise ValueError(
                    "observation_decisions must cover each selected observation id "
                    "exactly once; " + "; ".join(problems)
                )
            return self

    # ToolStrategy names the tool from __name__ and the schema title follows it;
    # keep the public name so the model never sees the per-run subclass.
    MemoryMaintenanceRunOutput.__name__ = MemoryMaintenanceOutput.__name__
    MemoryMaintenanceRunOutput.__qualname__ = MemoryMaintenanceOutput.__qualname__
    MemoryMaintenanceRunOutput.model_rebuild(force=True)
    return MemoryMaintenanceRunOutput
