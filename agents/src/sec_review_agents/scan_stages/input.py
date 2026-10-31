"""Shared repository scan controls prepared from validated public JSON."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class RepositoryChangedFile(BaseModel):
    """One change in the scan window, using the Execution API status vocabulary.

    Paths retain caller spelling. Discovery normalizes separators for workspace
    lookup; deletion review preserves its existing strip-only path semantics.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    path: Annotated[str, Field(pattern=r"\S")]
    status: Literal["added", "modified", "deleted", "renamed", "copied", "type_changed"]
    previous_path: str | None


class RepositoryScanScope(BaseModel):
    """Required scan controls shared by discovery and deletion review.

    Public schema validation remains at entry. Preparation constructs this model
    once; nested models are restored by Temporal instead of reparsing dictionaries
    in each consumer. Empty changed-file lists are valid incremental windows.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    paths_ignore: list[Annotated[str, Field(pattern=r"\S")]]
    incremental_changed_files: list[RepositoryChangedFile]
