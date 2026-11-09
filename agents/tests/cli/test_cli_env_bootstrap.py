import ast
import importlib
import os
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from tests.project_paths import PACKAGE_ROOT


def _module_tree(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _function_calls_name(function: ast.FunctionDef, name: str) -> bool:
    for node in ast.walk(function):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == name
        ):
            return True
    return False


def test_package_import_does_not_bootstrap_env() -> None:
    tree = _module_tree(PACKAGE_ROOT / "__init__.py")
    calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "bootstrap_agents_env"
    ]

    assert calls == []


def test_cli_mains_bootstrap_env_explicitly() -> None:
    cli_modules = [
        "run_local_issue.py",
        "run_local_pr.py",
        "run_local_repository.py",
        "check_llm_deployments.py",
    ]
    missing: list[str] = []

    for module_name in cli_modules:
        tree = _module_tree(PACKAGE_ROOT / "cli" / module_name)
        main = next(
            (
                node
                for node in tree.body
                if isinstance(node, ast.FunctionDef) and node.name == "main"
            ),
            None,
        )
        if main is None or not _function_calls_name(main, "bootstrap_agents_env"):
            missing.append(module_name)

    assert missing == []


@pytest.mark.parametrize(
    "module_name",
    [
        "run_local_issue",
        "run_local_pr",
        "run_local_repository",
        "check_llm_deployments",
    ],
)
def test_local_cli_loads_dotenv_without_overwriting_process_values(
    module_name: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Moving dotenv out of activities must preserve local entrypoint configuration."""
    module = importlib.import_module(f"sec_review_agents.cli.{module_name}")
    dotenv = tmp_path / ".env"
    dotenv.write_text(
        "AGENT_MEMORY_PROCESSING_ENABLED=false\n"
        "AGENT_MEMORY_CATALOG_TOKEN=file-token\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "sec_review_agents.utils.package_paths.default_agents_env_path", lambda: dotenv
    )
    monkeypatch.setattr("sec_review_agents.utils.env._AGENTS_ENV_BOOTSTRAPPED", False)
    monkeypatch.setattr(sys, "argv", [module_name, "--help"])
    with patch.dict(
        os.environ, {"AGENT_MEMORY_CATALOG_TOKEN": "process-token"}, clear=True
    ):
        with pytest.raises(SystemExit) as stopped:
            module.main()
        assert stopped.value.code == 0
        assert os.environ["AGENT_MEMORY_PROCESSING_ENABLED"] == "false"
        assert os.environ["AGENT_MEMORY_CATALOG_TOKEN"] == "process-token"
