from pydantic import BaseModel, Field

from sec_review_agents.utils.pydantic_types import NonEmptyText

# Agent structured output


class MitigationOutput(BaseModel):
    """Brief direction or blockage; the committed Git tree owns patch contents."""

    overview: NonEmptyText = Field(
        description=(
            "Compact top-line summary of the mitigation direction or why the stage could not fully act. "
            "Use it as brief downstream context rather than as a declaration of full repair. "
            "Prefer broad patch-direction language such as what was tightened, added, or left blocked, and avoid "
            "self-justifying success language or compressing detailed edit inventory into this field. "
            "Do not turn this field into a per-file edit inventory."
        ),
    )
