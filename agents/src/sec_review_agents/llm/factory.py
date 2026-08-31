from typing import Any

from langchain_anthropic import ChatAnthropic
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_openai import ChatOpenAI

from sec_review_agents.llm.config import (
    ChatDeploymentConfig,
    resolve_chat_deployment_by_name,
    resolve_chat_deployment_for_agent,
    reveal_secret,
    split_provider_model,
)

# Keep this explicit: ChatAnthropic replaces None with a model profile value,
# or falls back to 4096 for provider-routed model ids such as anthropic/glm-5.1.
# Anthropic-compatible endpoints reject values above 131072.
DEFAULT_ANTHROPIC_MAX_TOKENS = 131_072


def resolve_chat_deployment(
    *,
    agent_name: str | None = None,
    deployment_override: str | None = None,
) -> ChatDeploymentConfig:
    if deployment_override is not None:
        return resolve_chat_deployment_by_name(deployment_override)
    return resolve_chat_deployment_for_agent(agent_name)


def _validate_runtime_options(
    *,
    deployment: ChatDeploymentConfig,
    timeout_seconds: float | None,
    max_retries: int,
) -> None:
    if timeout_seconds is not None and timeout_seconds < 0:
        raise ValueError(
            f"Deployment '{deployment.deployment_name}' timeout_seconds must be >= 0."
        )
    if max_retries < 0:
        raise ValueError(
            f"Deployment '{deployment.deployment_name}' max_retries must be >= 0."
        )


def _build_openai_chat_model(
    *,
    deployment: ChatDeploymentConfig,
    provider_model: str,
    temperature: float,
    timeout_seconds: float | None,
    max_retries: int,
):
    kwargs: dict[str, Any] = {
        "model": provider_model,
        "api_key": reveal_secret(deployment.api_key),
        "temperature": temperature,
        "max_retries": max_retries,
    }
    if deployment.api_base:
        kwargs["base_url"] = deployment.api_base
    if deployment.api_version:
        kwargs["api_version"] = deployment.api_version
    if timeout_seconds is not None and timeout_seconds > 0:
        kwargs["timeout"] = timeout_seconds
    if deployment.reasoning_effort:
        kwargs["reasoning_effort"] = deployment.reasoning_effort
    return ChatOpenAI(**kwargs)


def _build_anthropic_chat_model(
    *,
    deployment: ChatDeploymentConfig,
    provider_model: str,
    temperature: float,
    timeout_seconds: float | None,
    max_retries: int,
):
    kwargs: dict[str, Any] = {
        "model": provider_model,
        "anthropic_api_key": reveal_secret(deployment.api_key),
        "temperature": temperature,
        "max_retries": max_retries,
    }
    if DEFAULT_ANTHROPIC_MAX_TOKENS is not None:
        kwargs["max_tokens_to_sample"] = DEFAULT_ANTHROPIC_MAX_TOKENS
    if deployment.api_base:
        kwargs["anthropic_api_url"] = deployment.api_base
    if timeout_seconds is not None and timeout_seconds > 0:
        kwargs["timeout"] = timeout_seconds
    if deployment.anthropic_effort:
        kwargs["effort"] = deployment.anthropic_effort
    return ChatAnthropic(**kwargs)


def _build_google_chat_model(
    *,
    deployment: ChatDeploymentConfig,
    provider_model: str,
    temperature: float,
    timeout_seconds: float | None,
    max_retries: int,
):
    kwargs: dict[str, Any] = {
        "model": provider_model,
        "api_key": reveal_secret(deployment.api_key),
        "temperature": temperature,
        "max_retries": max_retries,
    }
    if timeout_seconds is not None and timeout_seconds > 0:
        kwargs["timeout"] = timeout_seconds
    if deployment.api_base:
        kwargs["base_url"] = deployment.api_base
    return ChatGoogleGenerativeAI(**kwargs)


def create_chat_model_from_deployment(
    deployment: ChatDeploymentConfig,
    *,
    temperature: float = 0.0,
    timeout_seconds: float | None = None,
    max_retries: int | None = None,
):
    provider, provider_model = split_provider_model(deployment.model_id)
    effective_timeout_seconds = (
        timeout_seconds
        if timeout_seconds is not None
        else ((deployment.timeout_ms / 1000) if deployment.timeout_ms else None)
    )
    effective_max_retries = (
        max_retries if max_retries is not None else deployment.max_retries
    )
    _validate_runtime_options(
        deployment=deployment,
        timeout_seconds=effective_timeout_seconds,
        max_retries=effective_max_retries,
    )

    if provider == "openai":
        return _build_openai_chat_model(
            deployment=deployment,
            provider_model=provider_model,
            temperature=temperature,
            timeout_seconds=effective_timeout_seconds,
            max_retries=effective_max_retries,
        )
    if provider == "anthropic":
        return _build_anthropic_chat_model(
            deployment=deployment,
            provider_model=provider_model,
            temperature=temperature,
            timeout_seconds=effective_timeout_seconds,
            max_retries=effective_max_retries,
        )
    if provider == "google":
        return _build_google_chat_model(
            deployment=deployment,
            provider_model=provider_model,
            temperature=temperature,
            timeout_seconds=effective_timeout_seconds,
            max_retries=effective_max_retries,
        )

    raise ValueError(
        f"Unsupported chat deployment provider '{provider}' for '{deployment.deployment_name}'. "
        "Supported providers are: openai, anthropic, google."
    )


def create_chat_model(
    *,
    agent_name: str | None = None,
    deployment_override: str | None = None,
    temperature: float = 0.0,
):
    deployment = resolve_chat_deployment(
        agent_name=agent_name,
        deployment_override=deployment_override,
    )
    return create_chat_model_from_deployment(
        deployment,
        temperature=temperature,
    )
