"""Runtime acceptance gate for mitigation patch output."""

# Design notes for maintainers:
#
# `declared_changed_files[]` is the publishable patch key: declared paths must be
# observed in the workspace diff, while extra observed paths stay diagnostic and
# do not block acceptance.
#
# An empty `declared_changed_files` list means the agent declared no publishable
# patch. Workspace drift may still be observed for diagnostics, but it must not
# be promoted into patch content by falling back to a full-workspace diff.
#
# Flow:
# 1. Normalize declared `declared_changed_files[]`.
# 2. Observe workspace changes from the stage git workspace.
# 3. Require every declared path to be observed.
# 4. Export the declared-path patch and run `git apply --check` against a fresh
#    baseline.
# 5. Retry the same agent thread once on mismatch/apply failure, then fail hard.
#
# The middleware deliberately runs this gate from `after_model` and returns
# `jump_to="model"` on rejection. At that point the model has produced a
# candidate `structured_response`, but the agent graph has not yet committed that
# candidate as the final run result. That is the narrow point where we can append
# a runtime-fact correction message and re-enter the model node inside the same
# agent graph invocation.
#
# Using `after_agent` would make this a post-run repair again: the graph would
# have already completed, and jumping back to the model would blur finalization
# with retry. Keeping the rejection in `after_model` makes the LangGraph thread
# show one continuous agent loop: candidate response, workspace reconciliation
# feedback, retry model call, accepted structured response.

from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, NotRequired, override

from langchain.agents.middleware.types import (
    AgentMiddleware,
    AgentState,
    ContextT,
    OmitFromSchema,
    ResponseT,
    hook_config,
)
from langchain_core.messages import HumanMessage
from langgraph.channels.untracked_value import UntrackedValue
from langgraph.runtime import Runtime

from sec_review_agents.workspace.patches import (
    build_workspace_patch,
    check_workspace_patch_applies_to_fresh_baseline,
    normalize_declared_changed_files,
    observe_workspace_changed_files,
)

PRIVATE_STATE_ATTR = OmitFromSchema(input=True, output=True)


class ChangedFilesAcceptanceState(AgentState[ResponseT]):
    changed_files_acceptance_retry_count: NotRequired[
        Annotated[int, UntrackedValue, PRIVATE_STATE_ATTR]
    ]


def _structured_payload_dict(structured_response: Any) -> dict[str, Any]:
    if hasattr(structured_response, "model_dump"):
        return structured_response.model_dump(by_alias=True)
    if isinstance(structured_response, dict):
        return structured_response
    return {}


def _declared_changed_files(payload: dict[str, Any]) -> list[str]:
    raw_declared_paths = payload.get("declared_changed_files")
    if raw_declared_paths is None:
        return []
    if not isinstance(raw_declared_paths, list):
        raise ValueError("declared_changed_files must be a list.")
    return normalize_declared_changed_files(raw_declared_paths)


def _format_path_list(paths: list[str]) -> str:
    if not paths:
        return "- (none)"
    return "\n".join(f"- {path}" for path in paths)


def _changed_files_reconciliation_prompt(
    *,
    declared_paths: list[str],
    observed_paths: list[str],
    missing_declared_paths: list[str],
) -> str:
    return (
        "Your previous structured response was not accepted.\n\n"
        "Patch reconciliation failed:\n"
        "Declared changed files:\n"
        f"{_format_path_list(declared_paths)}\n\n"
        "Observed workspace changed files:\n"
        f"{_format_path_list(observed_paths)}\n\n"
        "Declared paths with no observed workspace change:\n"
        f"{_format_path_list(missing_declared_paths)}\n\n"
        "Every declared_changed_files path must have an observed workspace change before "
        "it can be delivered. Return one corrected structured response. Either "
        "remove paths that were not actually changed, or modify the workspace so "
        "the declared paths contain the intended fix. Do not modify unrelated files."
    )


def _patch_apply_reconciliation_prompt(
    *,
    declared_paths: list[str],
    apply_error: str,
) -> str:
    return (
        "Your previous structured response was not accepted.\n\n"
        "Patch apply check failed for the declared changed files:\n"
        f"{_format_path_list(declared_paths)}\n\n"
        "The runtime exported a scoped patch from those paths and checked it "
        "against a freshly restored baseline workspace. That patch did not apply:\n"
        f"{apply_error.strip() or 'git apply --check failed'}\n\n"
        "Return one corrected structured response after fixing the workspace. "
        "The declared_changed_files paths must still describe the intended "
        "publishable repair, and the exported patch for those paths must apply "
        "cleanly to the fresh baseline."
    )


def _invalid_declared_changed_files_prompt(error: Exception) -> str:
    return (
        "Your previous structured response was not accepted.\n\n"
        "Patch declaration failed:\n"
        f"{str(error).strip() or 'declared_changed_files contained invalid paths'}\n\n"
        "`declared_changed_files` must contain repository-relative file paths that "
        "are intentionally part of the patch. Do not use `/workspace`, "
        "`workspace/`, `a/`, `b/`, `.git`, parent-directory escapes, generated "
        "artifacts, caches, build output, or temporary files. Return one "
        "corrected structured response."
    )


@dataclass(frozen=True)
class ChangedFilesAcceptanceResult:
    accepted: bool
    retry_prompt: str | None = None
    error: Exception | None = None


def check_changed_files_acceptance(
    *,
    structured_response: Any,
    worktree_path: Path,
    baseline_snapshot_tar_path: Path,
    retry_attempts: int,
    max_retries: int,
) -> ChangedFilesAcceptanceResult:
    structured_payload = _structured_payload_dict(structured_response)
    try:
        declared_paths = _declared_changed_files(structured_payload)
    except ValueError as error:
        if retry_attempts >= max_retries:
            return ChangedFilesAcceptanceResult(accepted=False, error=error)
        return ChangedFilesAcceptanceResult(
            accepted=False,
            retry_prompt=_invalid_declared_changed_files_prompt(error),
        )

    observed_paths = observe_workspace_changed_files(worktree_path)
    observed_set = set(observed_paths)
    missing_declared_paths = [
        path for path in declared_paths if path not in observed_set
    ]

    if not missing_declared_paths:
        try:
            patch_artifact = build_workspace_patch(
                worktree_path,
                include_paths=declared_paths,
            )
            apply_error = check_workspace_patch_applies_to_fresh_baseline(
                baseline_snapshot_tar_path,
                patch_artifact["patch_content"],
            )
        except Exception as error:
            apply_error = str(error)

        if not apply_error:
            return ChangedFilesAcceptanceResult(accepted=True)

        if retry_attempts >= max_retries:
            return ChangedFilesAcceptanceResult(
                accepted=False,
                error=RuntimeError(
                    "generated workspace patch does not apply to a fresh baseline. "
                    f"declared_paths={declared_paths}; error={apply_error}"
                ),
            )

        return ChangedFilesAcceptanceResult(
            accepted=False,
            retry_prompt=_patch_apply_reconciliation_prompt(
                declared_paths=declared_paths,
                apply_error=apply_error,
            ),
        )

    if retry_attempts >= max_retries:
        return ChangedFilesAcceptanceResult(
            accepted=False,
            error=RuntimeError(
                "declared_changed_files include paths without observed workspace changes. "
                f"missing_declared={missing_declared_paths}; "
                f"observed={observed_paths}"
            ),
        )

    return ChangedFilesAcceptanceResult(
        accepted=False,
        retry_prompt=_changed_files_reconciliation_prompt(
            declared_paths=declared_paths,
            observed_paths=observed_paths,
            missing_declared_paths=missing_declared_paths,
        ),
    )


@dataclass(frozen=True)
class ChangedFilesAcceptanceMiddleware(
    AgentMiddleware[ChangedFilesAcceptanceState[ResponseT], ContextT, ResponseT]
):
    """Retry structured mitigation output until declared files match the patch."""

    worktree_path: Path
    baseline_snapshot_tar_path: Path
    max_retries: int = 1
    state_schema: type[ChangedFilesAcceptanceState[ResponseT]] = (
        ChangedFilesAcceptanceState
    )

    @hook_config(can_jump_to=["model"])
    @override
    def after_model(
        self,
        state: ChangedFilesAcceptanceState[ResponseT],
        runtime: Runtime[ContextT],
    ) -> dict[str, Any] | None:
        _ = runtime
        structured_response = state.get("structured_response")
        if structured_response is None:
            return None

        retry_count = state.get("changed_files_acceptance_retry_count", 0)
        acceptance = check_changed_files_acceptance(
            structured_response=structured_response,
            worktree_path=self.worktree_path,
            baseline_snapshot_tar_path=self.baseline_snapshot_tar_path,
            retry_attempts=retry_count,
            max_retries=self.max_retries,
        )
        if acceptance.accepted:
            return None
        if acceptance.error is not None:
            raise acceptance.error

        return {
            "jump_to": "model",
            "structured_response": None,
            "changed_files_acceptance_retry_count": retry_count + 1,
            "messages": [HumanMessage(content=acceptance.retry_prompt or "")],
        }

    async def aafter_model(
        self,
        state: ChangedFilesAcceptanceState[ResponseT],
        runtime: Runtime[ContextT],
    ) -> dict[str, Any] | None:
        return self.after_model(state, runtime)
