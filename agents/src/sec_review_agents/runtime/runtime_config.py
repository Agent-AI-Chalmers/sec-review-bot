"""Internal per-run runtime configuration, including local-only workspace paths.

The Execution Worker parses these values, then workflows and backends read them
while building stage runtime resources.

This is the only per-run override channel; everything a deployment sets for all
runs lives in ``AGENT_*`` environment variables instead. The accepted keys are a
closed allowlist, so a new override is an explicit change here rather than a new
field the request can smuggle in.
"""

import posixpath
from typing import Any, TypedDict

from sec_review_agents.utils.env import bool_env


class ExecutionRuntimeContext(TypedDict, total=False):
    workspace_image: str
    workspace_path: str


_ALLOWED_RUNTIME_CONFIG_KEYS = frozenset({"workspace_image", "workspace_path"})
ALLOW_WORKSPACE_IMAGE_OVERRIDE_ENV = "EXECUTION_ALLOW_WORKSPACE_IMAGE_OVERRIDE"


def runtime_workspace_path(runtime_context: ExecutionRuntimeContext | None) -> str:
    """Resolve the shared file-tool and shell repository root."""
    value = (runtime_context or {}).get("workspace_path", "/workspace")
    if (
        not isinstance(value, str)
        or not value.startswith("/")
        or value.startswith("//")
        or posixpath.normpath(value) != value
        or value == "/"
        or any(char in value for char in ("\x00", "\n", "\r", ","))
    ):
        raise ValueError(
            "runtime.workspace_path must be a normalized absolute directory"
        )
    return value


def runtime_context_from_config(value: Any) -> ExecutionRuntimeContext:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError("runtime must be an object.")

    unknown_keys = sorted(
        str(key) for key in value if key not in _ALLOWED_RUNTIME_CONFIG_KEYS
    )
    if unknown_keys:
        raise ValueError(
            "runtime contains unsupported key(s): " + ", ".join(unknown_keys)
        )

    context: ExecutionRuntimeContext = {}
    if "workspace_image" in value:
        if not bool_env(ALLOW_WORKSPACE_IMAGE_OVERRIDE_ENV, False):
            # Eval harnesses may opt in; production workers should use server config.
            raise ValueError(
                "runtime.workspace_image override is disabled; set "
                f"{ALLOW_WORKSPACE_IMAGE_OVERRIDE_ENV}=true to allow it."
            )
        workspace_image = value["workspace_image"]
        if not isinstance(workspace_image, str) or not workspace_image.strip():
            raise ValueError("runtime.workspace_image must be a non-empty string.")
        context["workspace_image"] = workspace_image.strip()
    if "workspace_path" in value:
        if not bool_env(ALLOW_WORKSPACE_IMAGE_OVERRIDE_ENV, False):
            raise ValueError("runtime.workspace_path override is disabled")
        workspace_path = value["workspace_path"]
        if not isinstance(workspace_path, str):
            raise ValueError("runtime.workspace_path must be a string")
        context["workspace_path"] = runtime_workspace_path(
            {"workspace_path": workspace_path}
        )
    return context


def runtime_workspace_image(
    runtime_context: ExecutionRuntimeContext | None,
) -> str | None:
    value = (runtime_context or {}).get("workspace_image")
    return value if isinstance(value, str) and value.strip() else None


__all__ = [
    "ALLOW_WORKSPACE_IMAGE_OVERRIDE_ENV",
    "ExecutionRuntimeContext",
    "runtime_context_from_config",
    "runtime_workspace_image",
]
