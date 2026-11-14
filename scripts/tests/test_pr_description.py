"""Keep PR metadata checks focused on a useful summary, not CI duplication."""

import runpy
from pathlib import Path

import pytest

_VALIDATOR = runpy.run_path(
    str(Path(__file__).resolve().parents[2] / ".github/ci/validate-pr-description.py")
)["validate_pull_request_description"]


_BODY = """## Summary

Reject invalid credentials.

## Compatibility

- [x] No compatibility impact
- [ ] Backward-compatible behavior change
- [ ] Breaking change
"""


@pytest.mark.parametrize(
    "suffix", ["", "\n## Validation\n\nManual reproduction passed."]
)
def test_validation_is_optional(suffix):
    _VALIDATOR(_BODY + suffix)


@pytest.mark.parametrize(
    "body",
    [
        "## Summary\nReject invalid credentials.",
        _BODY.replace("[x]", "[ ]"),
        _BODY.replace("[ ] Backward", "[x] Backward"),
        _BODY.replace("[x] No", "[ ] No").replace("[ ] Breaking", "[x] Breaking"),
    ],
)
def test_compatibility_requires_one_classification_and_breaking_explanation(body):
    with pytest.raises(ValueError):
        _VALIDATOR(body)


def test_breaking_change_with_migration_is_accepted():
    body = _BODY.replace("[x] No", "[ ] No").replace("[ ] Breaking", "[x] Breaking")
    _VALIDATOR(
        body + "\nOld tokens are rejected; operators must issue replacement tokens."
    )


@pytest.mark.parametrize(
    "body",
    ["", "## Summary\n<!-- Fill me in -->", "## Summary\nA\n## Summary\nB"],
)
def test_missing_empty_or_duplicate_summary_is_rejected(body):
    with pytest.raises(ValueError):
        _VALIDATOR(body)


def test_dependabot_can_use_its_own_nonempty_description():
    _VALIDATOR("Bumps a dependency.", "dependabot[bot]")
    with pytest.raises(ValueError):
        _VALIDATOR("", "dependabot[bot]")
