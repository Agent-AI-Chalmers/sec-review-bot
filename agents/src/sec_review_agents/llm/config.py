import os
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import SecretStr

from sec_review_agents.utils.package_paths import default_model_providers_config_path

DEFAULT_CHAT_DEPLOYMENT_MAX_RETRIES = 2
SUPPORTED_CHAT_DEPLOYMENT_PROVIDERS = frozenset({"openai", "anthropic", "google"})


@dataclass(frozen=True)
class ChatDeploymentConfig:
    deployment_name: str
    model_id: str
    max_input_tokens: int
    api_key: SecretStr
    api_base: str | None
    api_version: str | None
    timeout_ms: int | None
    max_retries: int
    reasoning_effort: str | None  # none minimal low medium high xhigh
    anthropic_effort: str | None  # low medium high max


@dataclass(frozen=True)
class LlmConfig:
    agent_deployment_bindings: dict[str, str]
    deployments: tuple[ChatDeploymentConfig, ...]


def _optional_env(name: str) -> str | None:
    value = (os.environ.get(name) or "").strip()
    return value or None


def _normalize_agent_key(agent_name: str | None) -> str:
    return str(agent_name or "").strip().lower().replace("_", "-")


def _resolve_config_toml_path() -> Path:
    configured = _optional_env("MODEL_PROVIDERS_CONFIG_TOML")
    if configured:
        return Path(configured).expanduser().resolve()
    return default_model_providers_config_path()


def resolve_config_toml_path() -> Path:
    return _resolve_config_toml_path()


def _load_config_document(required: bool) -> dict[str, Any] | None:
    config_path = _resolve_config_toml_path()
    if not config_path.exists():
        if required:
            raise ValueError(
                f"Model providers config file not found: {config_path}. "
                "Set MODEL_PROVIDERS_CONFIG_TOML to a valid TOML file path."
            )
        return None

    try:
        with config_path.open("rb") as handle:
            payload = tomllib.load(handle)
    except tomllib.TOMLDecodeError as error:
        raise ValueError(f"Invalid TOML in {config_path}: {error}") from error

    if not isinstance(payload, dict):
        raise ValueError(
            f"Model providers config root must be a TOML table: {config_path}"
        )

    return payload


def _require_string(mapping: dict[str, Any], key: str, *, ctx: str) -> str:
    value = str(mapping.get(key) or "").strip()
    if not value:
        raise ValueError(f"{ctx}.{key} is required")
    return value


def split_provider_model(model_id: str) -> tuple[str, str]:
    provider, separator, provider_model = model_id.partition("/")
    provider = provider.strip().lower()
    provider_model = provider_model.strip()
    if not separator or not provider or not provider_model:
        raise ValueError(
            f"Deployment model '{model_id}' must use '<provider>/<model>' format, "
            "for example 'openai/glm-5.1'."
        )
    return provider, provider_model


def _validate_supported_provider(model_id: str, *, ctx: str) -> None:
    provider, _provider_model = split_provider_model(model_id)
    if provider not in SUPPORTED_CHAT_DEPLOYMENT_PROVIDERS:
        supported = ", ".join(sorted(SUPPORTED_CHAT_DEPLOYMENT_PROVIDERS))
        raise ValueError(
            f"{ctx}.model uses unsupported provider '{provider}'. "
            f"Supported providers are: {supported}."
        )


def _optional_int(mapping: dict[str, Any], key: str, *, ctx: str) -> int | None:
    if key not in mapping:
        return None
    value = mapping.get(key)
    if value is None or str(value).strip() == "":
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{ctx}.{key} must be an integer") from error
    if parsed < 0:
        raise ValueError(f"{ctx}.{key} must be >= 0")
    return parsed


def _require_positive_int(mapping: dict[str, Any], key: str, *, ctx: str) -> int:
    if key not in mapping:
        raise ValueError(f"{ctx}.{key} is required")
    parsed = _optional_int(mapping, key, ctx=ctx)
    if parsed is None:
        raise ValueError(f"{ctx}.{key} is required")
    if parsed <= 0:
        raise ValueError(f"{ctx}.{key} must be > 0")
    return parsed


def reveal_secret(secret: SecretStr) -> str:
    return secret.get_secret_value()


def _build_chat_deployments_from_payload(
    payload: dict[str, Any],
) -> list[ChatDeploymentConfig]:
    deployments_node = payload.get("deployments")
    if not isinstance(deployments_node, list) or not deployments_node:
        raise ValueError(
            "deployments must be a non-empty TOML array-of-tables in the model providers config"
        )

    deployments: list[ChatDeploymentConfig] = []
    seen_names: set[str] = set()

    for index, item in enumerate(deployments_node):
        if not isinstance(item, dict):
            raise ValueError(f"deployments[{index}] must be a table")

        deployment_name = _require_string(item, "name", ctx=f"deployments[{index}]")
        model_id = _require_string(item, "model", ctx=f"deployments[{index}]")
        _validate_supported_provider(model_id, ctx=f"deployments[{index}]")
        max_input_tokens = _require_positive_int(
            item, "max_input_tokens", ctx=f"deployments[{index}]"
        )
        api_key = _require_string(item, "api_key", ctx=f"deployments[{index}]")
        api_base = str(item.get("api_base") or "").strip() or None
        api_version = str(item.get("api_version") or "").strip() or None
        timeout_ms = _optional_int(item, "timeout_ms", ctx=f"deployments[{index}]")
        max_retries = (
            _optional_int(item, "max_retries", ctx=f"deployments[{index}]")
            if "max_retries" in item
            else DEFAULT_CHAT_DEPLOYMENT_MAX_RETRIES
        )
        if max_retries is None:
            raise ValueError(
                f"deployments[{index}].max_retries must be an integer >= 0"
            )
        reasoning_effort = str(item.get("reasoning_effort") or "").strip() or None
        anthropic_effort = str(item.get("anthropic_effort") or "").strip() or None

        if deployment_name in seen_names:
            raise ValueError(
                f"Duplicate deployment name in model providers config: {deployment_name}"
            )

        seen_names.add(deployment_name)
        deployments.append(
            ChatDeploymentConfig(
                deployment_name=deployment_name,
                model_id=model_id,
                max_input_tokens=max_input_tokens,
                api_key=SecretStr(api_key),
                api_base=api_base,
                api_version=api_version,
                timeout_ms=timeout_ms,
                max_retries=max_retries,
                reasoning_effort=reasoning_effort,
                anthropic_effort=anthropic_effort,
            )
        )

    return deployments


def build_chat_deployments() -> list[ChatDeploymentConfig]:
    payload = _load_config_document(required=True) or {}
    return _build_chat_deployments_from_payload(payload)


def _build_chat_deployment_lookup(
    deployments: list[ChatDeploymentConfig],
) -> dict[str, ChatDeploymentConfig]:
    return {item.deployment_name: item for item in deployments}


def _resolve_agent_deployment_bindings_from_payload(
    payload: dict[str, Any],
    deployments: list[ChatDeploymentConfig],
) -> dict[str, str]:
    """Resolve agent-to-deployment bindings from the current config shape."""
    # Fail fast instead of silently ignoring the removed deployment table.
    if "stage_deployments" in payload:
        raise ValueError(
            "stage_deployments has been removed; use agent_deployment_bindings keyed by agent name."
        )
    if "agent_deployments" in payload:
        raise ValueError(
            "agent_deployments has been removed; use agent_deployment_bindings."
        )
    if "default_deployment" in payload:
        raise ValueError(
            "default_deployment has been removed; configure each agent explicitly in agent_deployment_bindings."
        )
    node = payload.get("agent_deployment_bindings") or {}
    if not isinstance(node, dict):
        raise ValueError(
            "agent_deployment_bindings must be a TOML table mapping agent -> deployment name"
        )

    valid_deployments = _build_chat_deployment_lookup(deployments)
    agent_deployment_bindings: dict[str, str] = {}
    for agent_name, deployment_name in node.items():
        normalized_agent = _normalize_agent_key(str(agent_name or ""))
        normalized_deployment = str(deployment_name or "").strip()
        if not normalized_agent:
            raise ValueError("agent_deployment_bindings contains an empty agent key")
        if normalized_deployment not in valid_deployments:
            raise ValueError(
                f"agent_deployment_bindings maps agent '{normalized_agent}' "
                f"to unknown deployment '{normalized_deployment}'."
            )
        agent_deployment_bindings[normalized_agent] = normalized_deployment

    return agent_deployment_bindings


def _unconfigured_llm_config() -> LlmConfig:
    return LlmConfig(
        agent_deployment_bindings={},
        deployments=(),
    )


def get_llm_config(*, required: bool = False) -> LlmConfig:
    payload = _load_config_document(required=required)
    if payload is None:
        return _unconfigured_llm_config()

    deployments = _build_chat_deployments_from_payload(payload)
    agent_deployment_bindings = _resolve_agent_deployment_bindings_from_payload(
        payload, deployments
    )

    return LlmConfig(
        agent_deployment_bindings=agent_deployment_bindings,
        deployments=tuple(deployments),
    )


def validate_llm_config_for_required_agents(
    llm_config: LlmConfig, required_agent_names: set[str] | frozenset[str]
) -> None:
    missing_bindings = sorted(
        {
            _normalize_agent_key(agent_name)
            for agent_name in required_agent_names
            if _normalize_agent_key(agent_name)
        }
        - set(llm_config.agent_deployment_bindings)
    )
    if missing_bindings:
        raise ValueError(
            "agent_deployment_bindings is missing required agent binding(s): "
            + ", ".join(missing_bindings)
        )


def get_llm_config_for_deployment_check(
    required_agent_names: set[str] | frozenset[str],
) -> LlmConfig:
    llm_config = get_llm_config(required=True)
    validate_llm_config_for_required_agents(llm_config, required_agent_names)
    return llm_config


def resolve_deployment_for_agent(agent_name: str | None) -> str:
    llm_config = get_llm_config()
    return resolve_deployment_for_agent_config(llm_config, agent_name)


def resolve_chat_deployment_by_name(
    deployment_name: str,
) -> ChatDeploymentConfig:
    llm_config = get_llm_config()
    lookup = _build_chat_deployment_lookup(list(llm_config.deployments))
    normalized_deployment = str(deployment_name or "").strip()
    if not normalized_deployment:
        raise ValueError("A deployment override must be a non-empty deployment name.")
    if normalized_deployment not in lookup:
        raise ValueError(f"Unknown chat deployment '{normalized_deployment}'.")
    return lookup[normalized_deployment]


def resolve_deployment_for_agent_config(
    llm_config: LlmConfig,
    agent_name: str | None,
) -> str:
    if not agent_name:
        raise ValueError("An agent name is required to resolve an LLM deployment.")

    normalized_agent = _normalize_agent_key(agent_name)
    if not normalized_agent:
        raise ValueError("An agent name is required to resolve an LLM deployment.")

    if normalized_agent not in llm_config.agent_deployment_bindings:
        raise ValueError(
            f"No LLM deployment configured for agent '{normalized_agent}'. "
            "Add it to agent_deployment_bindings in MODEL_PROVIDERS_CONFIG_TOML."
        )
    return llm_config.agent_deployment_bindings[normalized_agent]


def resolve_chat_deployment_for_agent_config(
    llm_config: LlmConfig,
    agent_name: str | None,
) -> ChatDeploymentConfig:
    deployment_name = resolve_deployment_for_agent_config(llm_config, agent_name)
    lookup = _build_chat_deployment_lookup(list(llm_config.deployments))
    if deployment_name not in lookup:
        raise ValueError(f"Unknown chat deployment '{deployment_name}'.")
    return lookup[deployment_name]


def resolve_chat_deployment_for_agent(
    agent_name: str | None,
) -> ChatDeploymentConfig:
    llm_config = get_llm_config()
    return resolve_chat_deployment_for_agent_config(llm_config, agent_name)
