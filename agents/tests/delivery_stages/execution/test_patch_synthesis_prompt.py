from sec_review_agents.delivery_stages.execution.patch_synthesis import (
    render_delivery_patch_synthesis_brief,
)


def test_reference_patch_is_inlined_without_per_patch_truncation() -> None:
    """Preserve a full large patch because synthesis has no per-case recovery path."""
    case_id = "case-large"
    patch_text = (
        "diff --git a/large.txt b/large.txt\n"
        "--- a/large.txt\n"
        "+++ b/large.txt\n"
        "@@ -1 +1 @@\n"
        f"-{'a' * 45_000}\n"
        f"+{'b' * 45_000}\n"
    )

    brief = render_delivery_patch_synthesis_brief(
        delivery_entry={
            "delivery_id": "combined-large",
            "strategy": "combined",
            "reason": "large-reference-patch",
            "case_ids": [case_id],
        },
        case_items=[
            {
                "case_id": case_id,
                "mitigator_changed_files": ["large.txt"],
                "mitigator_patch_diff": patch_text,
            }
        ],
    )

    reference_patch = brief.split("#### Reference Patch\n\n", 1)[1]
    expected_patch = patch_text.rstrip("\n")
    assert reference_patch == f"```diff\n{expected_patch}\n```\n"
