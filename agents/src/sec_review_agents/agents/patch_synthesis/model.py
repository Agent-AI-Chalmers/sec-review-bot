from pydantic import BaseModel, Field, model_validator

from sec_review_agents.workspace.patches import normalize_declared_changed_files

# Agent structured output


class PatchSynthesisOutput(BaseModel):
    declared_changed_files: list[str] = Field(
        default_factory=list,
        description=(
            "Final repository files intentionally changed by the patch synthesis agent. "
            "Each item must be a repository-relative file path that should be exported from the patch synthesis result. "
            "Do not report runtime/build side effects such as generated artifacts, dependency install output, "
            "caches, coverage, build outputs, or temporary files."
        ),
    )

    @model_validator(mode="after")
    def validate_result(self) -> PatchSynthesisOutput:
        self.declared_changed_files = normalize_declared_changed_files(
            self.declared_changed_files
        )
        if not self.declared_changed_files:
            raise ValueError(
                "agent patch synthesis output requires at least one declared_changed_files item."
            )
        return self


# Public exports

__all__ = [
    "PatchSynthesisOutput",
]
