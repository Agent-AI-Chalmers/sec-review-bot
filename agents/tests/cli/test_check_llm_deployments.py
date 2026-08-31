from pathlib import Path
from unittest.mock import patch

import pytest

from sec_review_agents.cli import check_llm_deployments
from sec_review_agents.llm.deployment_checks import DeploymentCheckResult, ProbeResult
from sec_review_agents.runtime.agent_names import RUNNABLE_AGENT_NAMES


def _write_model_config(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "model-providers.toml"
    path.write_text(body, encoding="utf-8")
    return path


def _successful_check(*, deployment, timeout_seconds, prompt, structured_prompt):
    return DeploymentCheckResult(
        deployment=deployment,
        ping=ProbeResult(ok=True, duration_seconds=0.001),
        structured=ProbeResult(ok=True, duration_seconds=0.002),
    )


def _all_required_agent_bindings(deployment_name: str) -> str:
    return "\n".join(
        f'{agent_name} = "{deployment_name}"'
        for agent_name in sorted(RUNNABLE_AGENT_NAMES)
    )


def test_check_llm_deployments_validates_agent_bindings(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    config_path = _write_model_config(
        tmp_path,
        f"""
[[deployments]]
name = "openai_fast"
model = "openai/gpt-4.1-mini"
max_input_tokens = 1047576
api_key = "primary-key"

[agent_deployment_bindings]
{_all_required_agent_bindings("openai_fast")}
""",
    )

    with (
        patch.dict(
            "os.environ",
            {"MODEL_PROVIDERS_CONFIG_TOML": str(config_path)},
            clear=True,
        ),
        patch("sys.argv", ["check_llm_deployments.py"]),
        patch(
            "sec_review_agents.cli.check_llm_deployments.check_deployment",
            side_effect=_successful_check,
        ) as check_deployment,
    ):
        check_llm_deployments.main()

    output = capsys.readouterr().out
    assert "CHAT_DEPLOYMENTS=1" in output
    assert f"AGENT_DEPLOYMENT_BINDINGS={len(RUNNABLE_AGENT_NAMES)}" in output
    check_deployment.assert_called_once()


def test_check_llm_deployments_rejects_deployments_without_agent_bindings(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    config_path = _write_model_config(
        tmp_path,
        """
[[deployments]]
name = "openai_fast"
model = "openai/gpt-4.1-mini"
max_input_tokens = 1047576
api_key = "primary-key"
""",
    )

    with (
        patch.dict(
            "os.environ",
            {"MODEL_PROVIDERS_CONFIG_TOML": str(config_path)},
            clear=True,
        ),
        patch("sys.argv", ["check_llm_deployments.py"]),
        patch(
            "sec_review_agents.cli.check_llm_deployments.check_deployment"
        ) as check_deployment,
        pytest.raises(SystemExit) as exit_info,
    ):
        check_llm_deployments.main()

    output = capsys.readouterr().out
    assert exit_info.value.code == 1
    assert "agent_deployment_bindings is missing required agent binding(s)" in output
    check_deployment.assert_not_called()


def test_check_llm_deployments_rejects_partial_agent_bindings(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    config_path = _write_model_config(
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

    with (
        patch.dict(
            "os.environ",
            {"MODEL_PROVIDERS_CONFIG_TOML": str(config_path)},
            clear=True,
        ),
        patch("sys.argv", ["check_llm_deployments.py"]),
        patch(
            "sec_review_agents.cli.check_llm_deployments.check_deployment"
        ) as check_deployment,
        pytest.raises(SystemExit) as exit_info,
    ):
        check_llm_deployments.main()

    output = capsys.readouterr().out
    assert exit_info.value.code == 1
    assert "agent_deployment_bindings is missing required agent binding(s)" in output
    assert "issue-verifier" in output
    check_deployment.assert_not_called()
