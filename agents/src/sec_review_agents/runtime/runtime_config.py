"""Per-run runtime overrides accepted by the runner request boundary.

Runner transport parses these values, then workflows and backends read them
while building stage runtime resources.
"""

from typing import Any, TypedDict

from sec_review_agents.utils.env import env_value, parse_bool_env


class RunnerRuntimeContext(TypedDict, total=False):
    workspace_image: str


_ALLOWED_RUNTIME_CONFIG_KEYS = frozenset({"workspace_image"})
ALLOW_WORKSPACE_IMAGE_OVERRIDE_ENV = "RUNNER_ALLOW_WORKSPACE_IMAGE_OVERRIDE"


def runtime_context_from_config(value: Any) -> RunnerRuntimeContext:
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

    context: RunnerRuntimeContext = {}
    if "workspace_image" in value:
        if not parse_bool_env(env_value(ALLOW_WORKSPACE_IMAGE_OVERRIDE_ENV), False):
            # Eval harnesses may opt in; production runners should use server config.
            raise ValueError(
                "runtime.workspace_image override is disabled; set "
                f"{ALLOW_WORKSPACE_IMAGE_OVERRIDE_ENV}=true to allow it."
            )
        workspace_image = value["workspace_image"]
        if not isinstance(workspace_image, str) or not workspace_image.strip():
            raise ValueError("runtime.workspace_image must be a non-empty string.")
        context["workspace_image"] = workspace_image.strip()
    return context


def runtime_workspace_image(runtime_context: RunnerRuntimeContext | None) -> str | None:
    value = (runtime_context or {}).get("workspace_image")
    return value if isinstance(value, str) and value.strip() else None


__all__ = [
    "ALLOW_WORKSPACE_IMAGE_OVERRIDE_ENV",
    "RunnerRuntimeContext",
    "runtime_context_from_config",
    "runtime_workspace_image",
]
