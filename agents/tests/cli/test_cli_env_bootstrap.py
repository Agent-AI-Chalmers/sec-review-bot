import ast
from pathlib import Path

AGENTS_ROOT = Path(__file__).resolve().parents[2]
SRC_ROOT = AGENTS_ROOT / "src" / "sec_review_agents"


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
    tree = _module_tree(SRC_ROOT / "__init__.py")
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
        tree = _module_tree(SRC_ROOT / "cli" / module_name)
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
