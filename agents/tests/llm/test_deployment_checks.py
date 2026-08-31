from unittest.mock import Mock, patch

from pydantic import SecretStr

from sec_review_agents.llm.config import ChatDeploymentConfig
from sec_review_agents.llm.deployment_checks import (
    StructuredProbeOutput,
    check_deployment,
)


def _deployment() -> ChatDeploymentConfig:
    return ChatDeploymentConfig(
        deployment_name="google_gemini",
        model_id="google/gemini-2.5-pro",
        max_input_tokens=1048576,
        api_key=SecretStr("key"),
        api_base=None,
        api_version=None,
        timeout_ms=None,
        max_retries=2,
        reasoning_effort=None,
        anthropic_effort=None,
    )


def test_check_deployment_reports_success() -> None:
    deployment = _deployment()
    with (
        patch(
            "sec_review_agents.llm.deployment_checks.create_chat_model_from_deployment",
            return_value=Mock(),
        ),
        patch("sec_review_agents.llm.deployment_checks.run_ping_probe"),
        patch(
            "sec_review_agents.llm.deployment_checks.run_structured_probe",
            return_value=StructuredProbeOutput(
                status="ok",
                deployment="google_gemini",
            ),
        ),
    ):
        result = check_deployment(
            deployment=deployment,
            timeout_seconds=1.0,
            prompt="ping",
            structured_prompt="structured",
        )

    assert result.deployment is deployment
    assert result.ping.ok
    assert result.structured.ok
    assert result.ping.error is None
    assert result.structured.error is None


def test_check_deployment_reports_probe_errors() -> None:
    deployment = _deployment()
    with (
        patch(
            "sec_review_agents.llm.deployment_checks.create_chat_model_from_deployment",
            return_value=Mock(),
        ),
        patch(
            "sec_review_agents.llm.deployment_checks.run_ping_probe",
            side_effect=RuntimeError("ping failed"),
        ),
        patch(
            "sec_review_agents.llm.deployment_checks.run_structured_probe",
            side_effect=RuntimeError("structured failed"),
        ),
    ):
        result = check_deployment(
            deployment=deployment,
            timeout_seconds=1.0,
            prompt="ping",
            structured_prompt="structured",
        )

    assert not result.ping.ok
    assert not result.structured.ok
    assert result.ping.error == "ping failed"
    assert result.structured.error == "structured failed"
