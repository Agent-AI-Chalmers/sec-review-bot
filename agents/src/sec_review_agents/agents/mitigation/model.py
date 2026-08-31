from pydantic import BaseModel, Field, model_validator

from sec_review_agents.workspace.patches import normalize_declared_changed_files

# Agent structured output


class MitigationOutput(BaseModel):
    """
    Keep `overview` and `declared_changed_files` aligned to what was actually changed.
    Treat `overview` as a brief description of patch direction or blockage, not as a self-certifying
    claim that the issue is fully fixed.
    Keep it shorter and less committal than the declared changed files: prefer describing what the patch changes in
    broad terms over declaring comprehensive success or repeating detailed edit inventory.
    `overview` should answer "what direction did this mitigation take?" while `declared_changed_files` declares which
    repository files are intentionally part of the patch.
    """

    overview: str = Field(
        description=(
            "Compact top-line summary of the mitigation direction or why the stage could not fully act. "
            "Use it as brief downstream context rather than as a declaration of full repair. "
            "Prefer broad patch-direction language such as what was tightened, added, or left blocked, and avoid "
            "self-justifying success language or compressing detailed edit inventory into this field. "
            "Do not turn this field into a per-file edit inventory."
        ),
    )
    declared_changed_files: list[str] = Field(
        default_factory=list,
        description=(
            "Repository-relative files intentionally changed by this mitigation and intended for patch export. "
            "Use paths like `src/app.py`; do not include `/workspace`, `workspace/`, `a/`, or `b/` prefixes. "
            "Exclude generated runtime artifacts, dependency install output, caches, coverage, build outputs, and temporary files."
        ),
    )

    @model_validator(mode="after")
    def validate_result(self) -> MitigationOutput:
        self.declared_changed_files = normalize_declared_changed_files(
            self.declared_changed_files
        )

        return self
