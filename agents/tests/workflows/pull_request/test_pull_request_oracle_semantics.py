"""Generic oracle semantics: how the matcher behaves, independent of any case on disk.

These exercise ForbiddenNarrative and accepted_narratives on data built here, so a change to a
case file cannot break them and a matcher regression cannot hide behind one. What a specific case
means is checked separately, against the real fixture.
"""

import json

import pytest

from tests.workflows.pull_request.cases.models import (
    ForbiddenNarrative,
    NarrativeRequirement,
    PullRequestCaseOracle,
)
from tests.workflows.pull_request.cases.runner import (
    _matches_forbidden,
    _narratives_accepted_by,
)


def _narrative(
    *,
    overview: str,
    files: list[str] | None = None,
    verdict: str = "confirmed-vulnerability",
):
    return {
        "verdict": verdict,
        "title": "t",
        "overview": overview,
        "locations": [{"file": name, "line": 1} for name in files or []],
    }


def _result(*narratives) -> dict:
    return {"verdict": "confirmed-vulnerability", "narratives": list(narratives)}


def _oracle(**overrides) -> PullRequestCaseOracle:
    data = {
        "required": [{"label": "mentions a sink", "any_of": ["sink"]}],
        "forbidden": [],
    }
    data.update(overrides)
    return PullRequestCaseOracle.model_validate(data)


def test_forbidden_rules_are_conjunctions() -> None:
    """A rule fires only when every field it sets holds, so shared vocabulary is not a verdict.

    A false positive and a correct finding usually share keywords. Only the combination -- this
    wording, no exculpatory evidence, this anchor -- separates them.
    """
    rule = ForbiddenNarrative(
        label="client only",
        any_of=["client"],
        none_of=["server"],
        files_only=["client.ts"],
    )
    forbidden = _narrative(
        overview="the client check is the boundary", files=["client.ts"]
    )
    names_server = _narrative(
        overview="the client check is not the boundary; server decides",
        files=["client.ts"],
    )
    anchored_elsewhere = _narrative(
        overview="the client check is the boundary", files=["other.ts"]
    )

    assert _matches_forbidden(forbidden, json.dumps(forbidden).lower(), rule)
    assert not _matches_forbidden(names_server, json.dumps(names_server).lower(), rule)
    assert not _matches_forbidden(
        anchored_elsewhere, json.dumps(anchored_elsewhere).lower(), rule
    )


def test_forbidden_patterns_are_regular_expressions() -> None:
    """Every pattern field follows one rule, so a case file never has to guess which applies.

    The escaped pattern `sink[.]ts` must match the literal text. Under substring matching it would
    never match, so the rule could not fire at all.
    """
    rule = ForbiddenNarrative(
        label="dot escape", any_of=["client"], none_of=["sink[.]ts"]
    )
    only_client = _narrative(overview="client-side only")
    names_sink = _narrative(overview="client-side, but sink.ts decides")

    assert _matches_forbidden(only_client, json.dumps(only_client).lower(), rule)
    assert not _matches_forbidden(names_sink, json.dumps(names_sink).lower(), rule)


def test_clearance_requirements_are_a_conjunction_of_disjunctions() -> None:
    """A narrative must satisfy every required item, and any single pattern within one."""
    oracle = _oracle(
        required=[
            {"label": "first", "any_of": ["alpha", "one"]},
            {"label": "second", "any_of": ["beta"]},
        ]
    )
    both = _narrative(overview="alpha and beta")
    alternative = _narrative(overview="one and beta")
    first_only = _narrative(overview="alpha")

    assert _narratives_accepted_by(oracle, _result(both, alternative, first_only)) == [
        both,
        alternative,
    ]


def test_forbidden_rules_scan_every_candidate_not_only_the_accepted_ones() -> None:
    """A false positive usually fails the requirements too, so filtering would let it through.

    The run must fail when a disallowed narrative appears anywhere among the confirmed ones, even
    beside a correct finding and even when it would not have been accepted on its own.
    """
    oracle = _oracle(
        required=[{"label": "mentions a sink", "any_of": ["sink"]}],
        forbidden=[{"label": "client only", "any_of": ["client check"]}],
    )
    correct = _narrative(overview="sink.ts has no check")
    false_positive = _narrative(overview="the client check is enough")

    with pytest.raises(AssertionError, match="forbidden"):
        _narratives_accepted_by(oracle, _result(correct, false_positive))


def test_an_anchor_must_be_a_literal_path_not_a_pattern() -> None:
    """`files_only` is compared against locations as text, so path characters are not special.

    A directory name can contain a parenthesis that no regular expression accepts. Validating it
    as a pattern would reject ordinary case data for a property the matcher never uses.
    """
    rule = ForbiddenNarrative(
        label="anchored in the odd directory",
        any_of=["client"],
        files_only=["src/routes/(admin.ts"],
    )
    narrative = _narrative(overview="a client check", files=["src/routes/(admin.ts"])

    assert rule.files_only == ["src/routes/(admin.ts"]
    assert _matches_forbidden(narrative, json.dumps(narrative).lower(), rule)
    assert NarrativeRequirement(label="l", any_of=["client"]).any_of == ["client"]
