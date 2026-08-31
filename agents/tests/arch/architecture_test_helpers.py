"""Small AST helpers for architecture tests.

These helpers intentionally report concrete imports and cycles. The tests that
use them should encode narrow architectural boundaries, not full dependency
snapshots that need updating for every harmless import.
"""

import ast
from pathlib import Path

import sec_review_agents

PACKAGE_ROOT = Path(sec_review_agents.__file__).resolve().parent


def import_violations(
    root: Path,
    forbidden_prefixes: tuple[str, ...],
    package_root: Path = PACKAGE_ROOT,
) -> list[str]:
    violations: list[str] = []
    paths = [root] if root.is_file() else list(root.rglob("*.py"))
    for path in paths:
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                module = node.module or ""
                if module.startswith(forbidden_prefixes):
                    violations.append(
                        f"{path.relative_to(package_root)} imports {module}"
                    )
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.startswith(forbidden_prefixes):
                        violations.append(
                            f"{path.relative_to(package_root)} imports {alias.name}"
                        )
    return violations


def module_import_edges(package_root: Path = PACKAGE_ROOT) -> dict[str, set[str]]:
    module_by_path: dict[Path, str] = {}
    for path in package_root.rglob("*.py"):
        relative = path.relative_to(package_root).with_suffix("")
        if relative.parts == ("__init__",):
            module = "sec_review_agents"
        else:
            module = "sec_review_agents." + ".".join(
                part for part in relative.parts if part != "__init__"
            )
        module_by_path[path] = module

    known_modules = set(module_by_path.values())
    edges: dict[str, set[str]] = {module: set() for module in known_modules}

    for path, module in module_by_path.items():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            imported_names: list[str] = []
            if isinstance(node, ast.ImportFrom):
                if node.level:
                    continue
                imported_names = [node.module or ""]
            elif isinstance(node, ast.Import):
                imported_names = [alias.name for alias in node.names]

            for imported_name in imported_names:
                target = _known_module_prefix(imported_name, known_modules)
                if target is not None and target != module:
                    edges[module].add(target)

    return edges


def _known_module_prefix(imported_name: str, known_modules: set[str]) -> str | None:
    if not imported_name.startswith("sec_review_agents"):
        return None
    parts = imported_name.split(".")
    for index in range(len(parts), 0, -1):
        candidate = ".".join(parts[:index])
        if candidate in known_modules:
            return candidate
    return None


def strongly_connected_modules(module_edges: dict[str, set[str]]) -> list[list[str]]:
    index_by_module: dict[str, int] = {}
    lowlink_by_module: dict[str, int] = {}
    stack: list[str] = []
    stacked: set[str] = set()
    components: list[list[str]] = []

    def visit(module: str) -> None:
        index_by_module[module] = len(index_by_module)
        lowlink_by_module[module] = index_by_module[module]
        stack.append(module)
        stacked.add(module)

        for target in module_edges[module]:
            if target not in index_by_module:
                visit(target)
                lowlink_by_module[module] = min(
                    lowlink_by_module[module],
                    lowlink_by_module[target],
                )
            elif target in stacked:
                lowlink_by_module[module] = min(
                    lowlink_by_module[module],
                    index_by_module[target],
                )

        if lowlink_by_module[module] != index_by_module[module]:
            return

        component: list[str] = []
        while True:
            target = stack.pop()
            stacked.remove(target)
            component.append(target)
            if target == module:
                break
        if len(component) > 1:
            components.append(sorted(component))

    for module in sorted(module_edges):
        if module not in index_by_module:
            visit(module)

    return sorted(components)
