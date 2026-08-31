from pathlib import Path

from sec_review_agents.workflows.repository.case_execution_input import (
    build_review_input,
)


def test_repository_review_input_renders_summary_evidence_and_anchors() -> None:
    markdown = build_review_input(
        case={
            "case_id": "case-1",
            "category": "business-logic",
            "summary": "Client supplied price may reach checkout.",
            "evidence": [
                "AddToCartButton passes book.price into cart state.",
                "Checkout must verify canonical prices before charging.",
            ],
            "anchor_locations": [
                {
                    "file": "src/components/AddToCartButton.tsx",
                    "line": 23,
                    "label": "book.price enters cart state",
                },
                {
                    "file": "src/app/checkout/page.tsx",
                    "label": "checkout flow",
                },
            ],
            "member_candidate_ids": ["cand-1"],
        },
        scan_mode="full",
    )

    assert "Client supplied price may reach checkout." in markdown
    assert "## Candidate Evidence" in markdown
    assert "AddToCartButton passes book.price into cart state." in markdown
    assert "## Candidate Anchors" in markdown
    assert "`src/components/AddToCartButton.tsx:23`" in markdown
    assert "`src/app/checkout/page.tsx`" in markdown
    assert "member_candidate_ids" not in markdown


def test_repository_review_input_renders_incremental_evidence_paths() -> None:
    markdown = build_review_input(
        case={
            "case_id": "case-1",
            "category": "business-logic",
            "summary": "Incremental case",
            "evidence": [],
            "anchor_locations": [],
            "member_candidate_ids": ["cand-1"],
        },
        scan_mode="incremental",
    )

    assert "## Incremental Evidence" in markdown
    assert "`/incremental-window/changed-files.json`" in markdown
    assert "`/incremental-window/incremental.patch`" in markdown
    assert "`/history/scan-window.json`" in markdown
    assert "`/history/commits.json`" in markdown


def test_repository_fix_prompts_consume_prepared_review_input() -> None:
    package_root = Path(__file__).resolve().parents[3] / "src" / "sec_review_agents"
    prompt_paths = [
        package_root / "workflows" / "repository_case" / "analysis.py",
        package_root / "workflows" / "repository_case" / "cvss.py",
        package_root / "workflows" / "repository_case" / "mitigation.py",
        package_root / "workflows" / "repository_case" / "verification.py",
    ]
    forbidden_tokens = (
        'input_data["case"]',
        'input_data.get("case")',
        "caseLabel",
        "category",
        "affectedPaths",
        "anchor_locations",
        "member_candidate_ids",
    )

    violations: list[str] = []
    for path in prompt_paths:
        source = path.read_text(encoding="utf-8")
        violations.extend(
            f"{path.name}: {token}" for token in forbidden_tokens if token in source
        )

    assert violations == []


def test_repository_review_input_is_only_fix_adapter_for_case_detail_fields() -> None:
    package_root = Path(__file__).resolve().parents[3] / "src" / "sec_review_agents"
    repository_case_root = package_root / "workflows" / "repository_case"
    forbidden_tokens = (
        "affectedPaths",
        "anchor_locations",
        "member_candidate_ids",
    )

    violations: list[str] = []
    for path in repository_case_root.rglob("*.py"):
        source = path.read_text(encoding="utf-8")
        violations.extend(
            f"{path.relative_to(package_root)}: {token}"
            for token in forbidden_tokens
            if token in source
        )

    assert violations == []
