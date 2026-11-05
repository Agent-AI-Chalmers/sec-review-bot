from sec_review_agents.review_stages import feedback_loop
from sec_review_agents.review_stages.mitigation.result import MitigationStageResult
from sec_review_agents.review_stages.verification.result import VerificationStageResult


def test_retry_decision_follows_verifier_next_step_without_requiring_a_patch() -> None:
    """A failed first mitigation can receive a bounded retry before any patch exists."""
    assert feedback_loop.should_retry_from_verifier_result(
        VerificationStageResult(
            next_step="retry-ai",
            overview="Test verification",
            target_claim=None,
            coverage=None,
            validation_level=None,
            regression=None,
        ),
    )
    assert not feedback_loop.should_retry_from_verifier_result(
        VerificationStageResult(
            next_step="none",
            overview="Test verification",
            target_claim=None,
            coverage=None,
            validation_level=None,
            regression=None,
        ),
    )
    assert not feedback_loop.should_retry_from_verifier_result(
        None,
    )


def test_feedback_retry_context_projects_previous_verifier_feedback() -> None:
    """Carry actionable verifier fields into retry context without raw artifacts."""
    retry_context = feedback_loop.feedback_retry_context(
        retry_index=1,
        mitigation_result=MitigationStageResult(
            overview="patched",
            file_changes=[{"path": "app.py", "status": "deleted"}],
            patch_diff="large diff must not enter retry context",
        ),
        verifier_result=VerificationStageResult(
            overview="needs revision",
            coverage="partial",
            next_step="retry-ai",
            regression="failed",
            findings=["missing guard"],
            target_claim=None,
            validation_level=None,
        ),
    )

    assert retry_context.retry_index == 1
    assert retry_context.previous_mitigation_summary is not None
    assert retry_context.previous_mitigation_summary.model_dump() == {
        "overview": "patched",
        "changed_files": ["app.py"],
    }
    assert retry_context.previous_verifier_summary is not None
    assert retry_context.previous_verifier_summary.model_dump() == {
        "overview": "needs revision",
        "target_claim": None,
        "coverage": "partial",
        "next_step": "retry-ai",
        "findings": ["missing guard"],
        "validation_level": None,
        "regression": "failed",
        "evidence": [],
        "residual_risks": [],
    }
    assert retry_context.previous_mitigation_summary is not None
    assert retry_context.previous_verifier_summary is not None
    assert "patch_diff" not in retry_context.previous_mitigation_summary.model_dump()
    assert "file_changes" not in retry_context.previous_mitigation_summary.model_dump()
    assert "raw_trace" not in retry_context.previous_verifier_summary.model_dump()
    assert [item.model_dump() for item in retry_context.history] == [
        {
            "retry_index": 1,
            "overview": "needs revision",
            "target_claim": None,
            "coverage": "partial",
            "next_step": "retry-ai",
            "findings": ["missing guard"],
            "validation_level": None,
            "regression": "failed",
            "evidence": [],
            "residual_risks": [],
        }
    ]


def test_feedback_retry_context_accumulates_previous_verifier_history() -> None:
    """Retain regression state across bounded verifier retry history."""
    first_retry_context = feedback_loop.feedback_retry_context(
        retry_index=1,
        mitigation_result=MitigationStageResult(overview="first patch"),
        verifier_result=VerificationStageResult(
            overview="first verifier",
            coverage="partial",
            next_step="retry-ai",
            regression="not-run",
            findings=["first gap"],
            target_claim=None,
            validation_level=None,
        ),
    )

    second_retry_context = feedback_loop.feedback_retry_context(
        retry_index=2,
        mitigation_result=MitigationStageResult(overview="second patch"),
        verifier_result=VerificationStageResult(
            overview="second verifier",
            coverage="partial",
            next_step="retry-ai",
            regression="passed",
            findings=["second gap"],
            target_claim=None,
            validation_level=None,
        ),
        history=first_retry_context.history,
    )

    assert [item.model_dump() for item in second_retry_context.history] == [
        {
            "retry_index": 1,
            "overview": "first verifier",
            "target_claim": None,
            "coverage": "partial",
            "next_step": "retry-ai",
            "findings": ["first gap"],
            "validation_level": None,
            "regression": "not-run",
            "evidence": [],
            "residual_risks": [],
        },
        {
            "retry_index": 2,
            "overview": "second verifier",
            "target_claim": None,
            "coverage": "partial",
            "next_step": "retry-ai",
            "findings": ["second gap"],
            "validation_level": None,
            "regression": "passed",
            "evidence": [],
            "residual_risks": [],
        },
    ]
    assert second_retry_context.previous_verifier_summary is not None
    assert second_retry_context.previous_verifier_summary.overview == (
        "second verifier"
    )


def test_retry_prompt_retains_changed_paths_after_summary_projection() -> None:
    """A compact summary must not be interpreted again as a raw stage result."""
    context = feedback_loop.feedback_retry_context(
        retry_index=1,
        mitigation_result=MitigationStageResult(
            overview="Added a guard",
            file_changes=[
                {
                    "path": "src/guard.py",
                    "status": "upsert",
                    "content": "secret body",
                    "content_encoding": "utf-8",
                }
            ],
            patch_diff="private raw patch",
        ),
        verifier_result=VerificationStageResult(
            overview="Guard needs revision",
            target_claim=None,
            coverage=None,
            next_step="none",
            validation_level=None,
            regression=None,
        ),
    )
    projected = feedback_loop.mitigation_feedback_retry_context(context)
    assert projected is not None
    assert projected.previous_mitigation is not None
    assert projected.previous_mitigation.model_dump() == {
        "overview": "Added a guard",
        "changed_files": ["src/guard.py"],
    }
    rendered = feedback_loop.render_retry_revision_context_section(projected)
    assert rendered is not None
    assert "src/guard.py" in rendered
    assert "secret body" not in rendered
    assert "private raw patch" not in rendered
