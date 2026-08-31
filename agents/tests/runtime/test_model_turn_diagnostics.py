from unittest.mock import patch

from langchain_core.messages import AIMessage

from sec_review_agents.runtime.model_turn_diagnostics import (
    ModelTurnDiagnosticsMiddleware,
    _has_substantive_content,
)


def test_empty_text_content_block_is_not_substantive() -> None:
    message = AIMessage(content=[{"type": "text", "text": "   "}])

    assert not _has_substantive_content(message)


def test_text_content_block_without_text_field_is_not_substantive() -> None:
    message = AIMessage(content=[{"type": "text"}])

    assert not _has_substantive_content(message)


def test_bare_typed_content_block_is_not_substantive() -> None:
    message = AIMessage(content=[{"type": "output_text"}])

    assert not _has_substantive_content(message)


def test_non_empty_text_content_block_is_substantive() -> None:
    message = AIMessage(content=[{"type": "text", "text": "Reviewed patch."}])

    assert _has_substantive_content(message)


def test_non_text_content_block_remains_substantive() -> None:
    message = AIMessage(
        content=[
            {
                "type": "image_url",
                "image_url": {"url": "https://example.test/image.png"},
            }
        ]
    )

    assert _has_substantive_content(message)


def test_warning_diagnostics_use_agent_identity() -> None:
    middleware = ModelTurnDiagnosticsMiddleware(agent_name="issue-analyzer")

    with patch(
        "sec_review_agents.runtime.model_turn_diagnostics.log_diagnostic"
    ) as log_mock:
        middleware.after_model(
            {"messages": []},
            runtime=None,  # type: ignore[arg-type]  # Runtime is unused by this diagnostic branch.
        )

    log_mock.assert_called_once_with(
        "model_turn_diagnostics_warning",
        agent="issue-analyzer",
        reason="missing_messages_after_model",
    )
