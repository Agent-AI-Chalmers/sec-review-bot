from sec_review_agents.delivery_stages.execution.patch_synthesis import (
    render_delivery_patch_synthesis_brief,
)


def test_reference_patch_is_inlined_without_per_patch_truncation() -> None:
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

    assert patch_text.rstrip("\n") in brief
    assert "available" not in brief
    assert "path" not in brief
    assert "truncated" not in brief
    assert "original_char_count" not in brief
    assert "reference patch truncated" not in brief
