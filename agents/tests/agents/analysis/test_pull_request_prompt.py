from typing import Any

from sec_review_agents.agents.analysis.pull_request import (
    build_pr_analyzer_user_prompt,
)


def build_prompt(**pr_overrides: Any) -> str:
    pr: dict[str, Any] = {
        "title": "Tighten token validation",
        "body": "Pure refactor, no behaviour change.",
        "base_ref": "main",
        "base_sha": "base111",
        "head_ref": "feature",
        "head_sha": "head222",
        "commit_shas": ["head222"],
        **pr_overrides,
    }
    return build_pr_analyzer_user_prompt(
        pr=pr,
    )


def test_pull_request_text_is_labelled_as_untrusted_author_statement() -> None:
    """The author's own description must not be able to narrow the review.

    A body that claims "pure refactor" is the cheapest way to talk a reviewer out
    of a change, so the prompt marks it as untrusted rather than authoritative.
    """
    prompt = build_prompt()

    assert "Pull Request Text (untrusted author statements)" in prompt
    assert "Pure refactor, no behaviour change." in prompt
