from typing import Annotated

from pydantic import StringConstraints

# Text that has to carry content. An empty or whitespace-only string would satisfy a
# required field while saying nothing, so the rule is bound here instead of being
# restated per model: agent output models had already reached for `Field(min_length=1)`
# in several places, which counts characters and lets `"   "` through.
NonEmptyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
