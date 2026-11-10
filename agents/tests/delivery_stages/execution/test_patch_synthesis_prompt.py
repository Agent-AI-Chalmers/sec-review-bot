from sec_review_agents.delivery_stages.execution.input import DeliveryPatchCase
from sec_review_agents.delivery_stages.execution.patch_synthesis import (
    render_delivery_patch_synthesis_brief,
)
from sec_review_agents.delivery_stages.model import DeliveryEntry


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
        delivery_entry=DeliveryEntry(
            delivery_id="combined-large",
            strategy="combined",
            reason="large-reference-patch",
            case_ids=[case_id],
        ),
        case_items=[
            DeliveryPatchCase(
                case_id=case_id,
                mitigator_file_changes=[
                    {
                        "path": "large.txt",
                        "status": "upsert",
                        "content": "replacement\n",
                        "content_encoding": "utf-8",
                    }
                ],
                mitigator_patch_diff=patch_text,
            )
        ],
    )

    reference_patch = brief.split("#### Reference Patch\n\n", 1)[1]
    expected_patch = patch_text.rstrip("\n")
    assert reference_patch == f"```diff\n{expected_patch}\n```\n"


def test_brief_renders_every_section_the_system_prompt_names() -> None:
    """The system prompt tells synthesis to read these brief sections.

    It once also named verifier summaries the brief never carried, which sent
    the agent looking for missing inputs; keep the rendered sections in step.
    """
    brief = render_delivery_patch_synthesis_brief(
        delivery_entry=DeliveryEntry(
            delivery_id="combined",
            strategy="combined",
            reason="shared helper",
            case_ids=["a", "b"],
        ),
        case_items=[
            DeliveryPatchCase(
                case_id=case_id,
                mitigator_file_changes=[
                    {
                        "path": "shared.py",
                        "status": "upsert",
                        "content": "x\n",
                        "content_encoding": "utf-8",
                    }
                ],
                mitigator_patch_diff="diff --git a/shared.py b/shared.py\n",
            )
            for case_id in ["a", "b"]
        ],
    )

    for section in ("## Overlapping Case Files", "## Cases", "#### Reference Patch"):
        assert section in brief
    assert "- Changed files: `shared.py`" in brief
