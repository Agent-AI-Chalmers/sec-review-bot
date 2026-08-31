import os
from pathlib import Path
from unittest.mock import patch

import pytest
from langchain_anthropic import ChatAnthropic
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_openai import ChatOpenAI
from pydantic import SecretStr

import sec_review_agents.llm.config as llm_config_module
from sec_review_agents.llm.config import (
    ChatDeploymentConfig,
    build_chat_deployments,
    get_llm_config,
    get_llm_config_for_deployment_check,
    resolve_chat_deployment_by_name,
    resolve_chat_deployment_for_agent,
    resolve_deployment_for_agent,
    reveal_secret,
    validate_llm_config_for_required_agents,
)
from sec_review_agents.llm.factory import (
    create_chat_model,
    create_chat_model_from_deployment,
    resolve_chat_deployment,
)


def _write_toml(tmp_path: Path, content: str) -> str:
    config_path = tmp_path / "model-providers.toml"
    config_path.write_text(content, encoding="utf-8")
    return str(config_path)


def _base_toml() -> str:
    return """
[[deployments]]
name = "openai_fast"
model = "openai/gpt-4.1-mini"
max_input_tokens = 1047576
api_key = "primary-key"
api_base = "https://primary.example/v1"
timeout_ms = 60000
max_retries = 3

[[deployments]]
name = "anthropic_strong"
model = "anthropic/claude-3-7-sonnet-20250219"
max_input_tokens = 200000
api_key = "secondary-key"
max_retries = 4

[[deployments]]
name = "google_gemini"
model = "google/gemini-2.5-pro"
max_input_tokens = 1048576
api_key = "google-key"
api_base = "https://google.example"

[agent_deployment_bindings]
repository-discovery = "openai_fast"
repository-triager = "openai_fast"
issue-analyzer = "anthropic_strong"
issue-verifier = "google_gemini"
"""


def test_multi_deployment_and_agent_selection_config(tmp_path: Path) -> None:
    config_path = _write_toml(tmp_path, _base_toml())
    env = {"MODEL_PROVIDERS_CONFIG_TOML": config_path}

    with patch.dict(os.environ, env, clear=True):
        get_llm_config()
        deployments = build_chat_deployments()

        assert len(deployments) == 3
        assert deployments[0].deployment_name == "openai_fast"
        assert deployments[0].max_input_tokens == 1047576
        assert deployments[0].timeout_ms == 60000
        assert deployments[0].max_retries == 3
        assert isinstance(deployments[0].api_key, SecretStr)
        assert reveal_secret(deployments[0].api_key) == "primary-key"
        assert "primary-key" not in repr(deployments[0])
        assert deployments[1].deployment_name == "anthropic_strong"
        assert deployments[1].timeout_ms is None
        assert deployments[1].max_retries == 4
        assert deployments[2].deployment_name == "google_gemini"
        assert deployments[2].max_retries == 2
        assert resolve_deployment_for_agent("issue-analyzer") == "anthropic_strong"
        assert resolve_deployment_for_agent("issue-verifier") == "google_gemini"


def test_factory_builds_provider_native_models(tmp_path: Path) -> None:
    config_path = _write_toml(tmp_path, _base_toml())
    env = {"MODEL_PROVIDERS_CONFIG_TOML": config_path}

    with patch.dict(os.environ, env, clear=True):
        analysis_deployment = resolve_chat_deployment(agent_name="issue-analyzer")
        assert analysis_deployment.deployment_name == "anthropic_strong"
        analysis_model = create_chat_model(agent_name="issue-analyzer")
        assert isinstance(analysis_model, ChatAnthropic)
        assert analysis_model.max_retries == 4

        discovery_deployment = resolve_chat_deployment(
            agent_name="repository-discovery"
        )
        assert discovery_deployment.deployment_name == "openai_fast"
        discovery_model = create_chat_model(agent_name="repository-discovery")
        assert isinstance(discovery_model, ChatOpenAI)
        assert discovery_model.max_retries == 3
        assert discovery_model.openai_api_base == "https://primary.example/v1"
        assert discovery_model.request_timeout == 60.0

        verifier_deployment = resolve_chat_deployment(agent_name="issue-verifier")
        assert verifier_deployment.deployment_name == "google_gemini"
        verifier_model = create_chat_model(agent_name="issue-verifier")
        assert isinstance(verifier_model, ChatGoogleGenerativeAI)
        assert verifier_model.max_retries == 2
        assert verifier_model.base_url == "https://google.example"


def test_factory_allows_call_level_deployment_override(tmp_path: Path) -> None:
    config_path = _write_toml(tmp_path, _base_toml())
    env = {"MODEL_PROVIDERS_CONFIG_TOML": config_path}

    with patch.dict(os.environ, env, clear=True):
        default_deployment = resolve_chat_deployment(agent_name="issue-analyzer")
        override_deployment = resolve_chat_deployment(
            agent_name="issue-analyzer",
            deployment_override="openai_fast",
        )
        direct_deployment = resolve_chat_deployment_by_name("openai_fast")
        override_model = create_chat_model(
            agent_name="issue-analyzer",
            deployment_override="openai_fast",
        )

    assert default_deployment.deployment_name == "anthropic_strong"
    assert override_deployment.deployment_name == "openai_fast"
    assert direct_deployment.deployment_name == "openai_fast"
    assert isinstance(override_model, ChatOpenAI)


def test_unknown_deployment_override_is_rejected(tmp_path: Path) -> None:
    config_path = _write_toml(tmp_path, _base_toml())
    env = {"MODEL_PROVIDERS_CONFIG_TOML": config_path}

    with (
        patch.dict(os.environ, env, clear=True),
        pytest.raises(ValueError, match="Unknown chat deployment"),
    ):
        resolve_chat_deployment(
            agent_name="issue-analyzer",
            deployment_override="missing_deployment",
        )


def test_factory_allows_disabling_deployment_retries(tmp_path: Path) -> None:
    config_path = _write_toml(
        tmp_path,
        """
[[deployments]]
name = "anthropic_zero_retry"
model = "anthropic/claude-3-7-sonnet-20250219"
max_input_tokens = 200000
api_key = "secondary-key"
max_retries = 0

[agent_deployment_bindings]
issue-analyzer = "anthropic_zero_retry"
""",
    )
    env = {"MODEL_PROVIDERS_CONFIG_TOML": config_path}

    with patch.dict(os.environ, env, clear=True):
        analysis_model = create_chat_model(agent_name="issue-analyzer")
        assert analysis_model.max_retries == 0


def test_factory_rejects_blank_provider_model_parts() -> None:
    deployment = ChatDeploymentConfig(
        deployment_name="bad_model",
        model_id="openai/   ",
        max_input_tokens=1047576,
        api_key=SecretStr("key"),
        api_base=None,
        api_version=None,
        timeout_ms=None,
        max_retries=2,
        reasoning_effort=None,
        anthropic_effort=None,
    )

    with pytest.raises(ValueError, match="<provider>/<model>"):
        create_chat_model_from_deployment(deployment)


def test_factory_rejects_negative_runtime_options() -> None:
    deployment = ChatDeploymentConfig(
        deployment_name="openai_fast",
        model_id="openai/gpt-4.1-mini",
        max_input_tokens=1047576,
        api_key=SecretStr("key"),
        api_base=None,
        api_version=None,
        timeout_ms=None,
        max_retries=2,
        reasoning_effort=None,
        anthropic_effort=None,
    )

    with pytest.raises(ValueError, match="timeout_seconds must be >= 0"):
        create_chat_model_from_deployment(deployment, timeout_seconds=-0.1)
    with pytest.raises(ValueError, match="max_retries must be >= 0"):
        create_chat_model_from_deployment(deployment, max_retries=-1)


def test_missing_model_provider_config_means_no_llm_config(tmp_path: Path) -> None:
    missing_path = tmp_path / "missing-model-providers.toml"
    env = {"MODEL_PROVIDERS_CONFIG_TOML": str(missing_path)}

    with patch.dict(os.environ, env, clear=True):
        llm_config = get_llm_config()

        assert llm_config.deployments == ()
        with pytest.raises(ValueError, match="config file not found"):
            get_llm_config_for_deployment_check({"issue-analyzer"})


def test_missing_default_model_provider_config_means_no_llm_config(
    tmp_path: Path,
) -> None:
    missing_path = tmp_path / "config" / "model-providers.toml"

    with (
        patch.dict(os.environ, {}, clear=True),
        patch(
            "sec_review_agents.llm.config.default_model_providers_config_path",
            return_value=missing_path,
        ),
    ):
        llm_config = get_llm_config()

        assert llm_config.deployments == ()
        with pytest.raises(ValueError, match="config file not found"):
            get_llm_config_for_deployment_check({"issue-analyzer"})


def test_deployment_check_rejects_missing_agent_bindings(tmp_path: Path) -> None:
    config_path = _write_toml(
        tmp_path,
        """
[[deployments]]
name = "openai_fast"
model = "openai/gpt-4.1-mini"
max_input_tokens = 1047576
api_key = "primary-key"
""",
    )
    env = {"MODEL_PROVIDERS_CONFIG_TOML": config_path}

    with patch.dict(os.environ, env, clear=True):
        llm_config = get_llm_config()

        assert len(llm_config.deployments) == 1
        assert llm_config.agent_deployment_bindings == {}
        with pytest.raises(ValueError, match="agent_deployment_bindings is missing"):
            get_llm_config_for_deployment_check({"issue-analyzer"})


def test_required_agent_binding_validation_is_parameterized(tmp_path: Path) -> None:
    config_path = _write_toml(
        tmp_path,
        """
[[deployments]]
name = "openai_fast"
model = "openai/gpt-4.1-mini"
max_input_tokens = 1047576
api_key = "primary-key"

[agent_deployment_bindings]
issue-analyzer = "openai_fast"
""",
    )
    env = {"MODEL_PROVIDERS_CONFIG_TOML": config_path}

    with patch.dict(os.environ, env, clear=True):
        llm_config = get_llm_config()

        validate_llm_config_for_required_agents(llm_config, {"issue-analyzer"})
        with pytest.raises(ValueError, match="issue-verifier"):
            validate_llm_config_for_required_agents(
                llm_config, {"issue-analyzer", "issue-verifier"}
            )


def test_default_deployment_is_rejected(tmp_path: Path) -> None:
    config_path = _write_toml(
        tmp_path,
        """
default_deployment = "openai_fast"

[[deployments]]
name = "openai_fast"
model = "openai/gpt-4.1-mini"
max_input_tokens = 1047576
api_key = "primary-key"

[agent_deployment_bindings]
issue-analyzer = "openai_fast"
""",
    )
    env = {"MODEL_PROVIDERS_CONFIG_TOML": config_path}

    with (
        patch.dict(os.environ, env, clear=True),
        pytest.raises(ValueError, match="default_deployment has been removed"),
    ):
        get_llm_config()


def test_unmapped_agent_is_rejected(tmp_path: Path) -> None:
    config_path = _write_toml(tmp_path, _base_toml())
    env = {"MODEL_PROVIDERS_CONFIG_TOML": config_path}

    with patch.dict(os.environ, env, clear=True):
        with pytest.raises(ValueError, match="No LLM deployment configured"):
            resolve_deployment_for_agent("issue-cvss")
        with pytest.raises(ValueError, match="No LLM deployment configured"):
            resolve_chat_deployment_for_agent("issue-cvss")
        with pytest.raises(ValueError, match="agent name is required"):
            resolve_deployment_for_agent(None)


def test_malformed_model_provider_config_is_not_treated_as_no_model(
    tmp_path: Path,
) -> None:
    config_path = _write_toml(tmp_path, "not = [valid")
    env = {"MODEL_PROVIDERS_CONFIG_TOML": config_path}

    with (
        patch.dict(os.environ, env, clear=True),
        pytest.raises(ValueError, match="Invalid TOML"),
    ):
        get_llm_config()


def test_invalid_deployment_config_is_not_treated_as_no_model(tmp_path: Path) -> None:
    config_path = _write_toml(
        tmp_path,
        """
[[deployments]]
name = "openai_fast"
api_key = "primary-key"
""",
    )
    env = {"MODEL_PROVIDERS_CONFIG_TOML": config_path}

    with (
        patch.dict(os.environ, env, clear=True),
        pytest.raises(ValueError, match=r"deployments\[0\].model"),
    ):
        get_llm_config()


def test_missing_max_input_tokens_is_rejected(tmp_path: Path) -> None:
    config_path = _write_toml(
        tmp_path,
        """
[[deployments]]
name = "openai_fast"
model = "openai/gpt-4.1-mini"
api_key = "primary-key"
""",
    )
    env = {"MODEL_PROVIDERS_CONFIG_TOML": config_path}

    with (
        patch.dict(os.environ, env, clear=True),
        pytest.raises(
            ValueError,
            match=r"deployments\[0\].max_input_tokens is required",
        ),
    ):
        get_llm_config()


def test_non_positive_max_input_tokens_is_rejected(tmp_path: Path) -> None:
    config_path = _write_toml(
        tmp_path,
        """
[[deployments]]
name = "openai_fast"
model = "openai/gpt-4.1-mini"
max_input_tokens = 0
api_key = "primary-key"
""",
    )
    env = {"MODEL_PROVIDERS_CONFIG_TOML": config_path}

    with (
        patch.dict(os.environ, env, clear=True),
        pytest.raises(
            ValueError,
            match=r"deployments\[0\].max_input_tokens must be > 0",
        ),
    ):
        get_llm_config()


def test_unsupported_deployment_provider_is_rejected(tmp_path: Path) -> None:
    config_path = _write_toml(
        tmp_path,
        """
[[deployments]]
name = "ollama_local"
model = "ollama/qwen3"
api_key = "local-key"
""",
    )
    env = {"MODEL_PROVIDERS_CONFIG_TOML": config_path}

    with (
        patch.dict(os.environ, env, clear=True),
        pytest.raises(ValueError, match="unsupported provider 'ollama'"),
    ):
        get_llm_config()


def test_stage_deployment_table_is_rejected(tmp_path: Path) -> None:
    config_path = _write_toml(
        tmp_path,
        """
[[deployments]]
name = "openai_fast"
model = "openai/gpt-4.1-mini"
max_input_tokens = 1047576
api_key = "primary-key"

[stage_deployments]
analysis = "openai_fast"
""",
    )
    env = {"MODEL_PROVIDERS_CONFIG_TOML": config_path}

    with (
        patch.dict(os.environ, env, clear=True),
        pytest.raises(ValueError, match="stage_deployments"),
    ):
        get_llm_config()


def test_removed_agent_deployments_table_is_rejected(tmp_path: Path) -> None:
    config_path = _write_toml(
        tmp_path,
        """
[[deployments]]
name = "openai_fast"
model = "openai/gpt-4.1-mini"
max_input_tokens = 1047576
api_key = "primary-key"

[agent_deployments]
issue-analyzer = "openai_fast"
""",
    )
    env = {"MODEL_PROVIDERS_CONFIG_TOML": config_path}

    with (
        patch.dict(os.environ, env, clear=True),
        pytest.raises(ValueError, match="agent_deployments has been removed"),
    ):
        get_llm_config()


def test_get_llm_config_reads_config_document_once(tmp_path: Path) -> None:
    config_path = _write_toml(tmp_path, _base_toml())
    env = {"MODEL_PROVIDERS_CONFIG_TOML": config_path}

    with (
        patch.dict(os.environ, env, clear=True),
        patch(
            "sec_review_agents.llm.config._load_config_document",
            wraps=llm_config_module._load_config_document,
        ) as load_config_document,
    ):
        llm_config = get_llm_config()

    assert len(llm_config.deployments) == 3
    load_config_document.assert_called_once_with(required=False)


def test_create_chat_model_reads_config_document_once(tmp_path: Path) -> None:
    config_path = _write_toml(tmp_path, _base_toml())
    env = {"MODEL_PROVIDERS_CONFIG_TOML": config_path}

    with (
        patch.dict(os.environ, env, clear=True),
        patch(
            "sec_review_agents.llm.config._load_config_document",
            wraps=llm_config_module._load_config_document,
        ) as load_config_document,
    ):
        model = create_chat_model(agent_name="issue-analyzer")

    assert type(model).__name__ == "ChatAnthropic"
    load_config_document.assert_called_once_with(required=False)
