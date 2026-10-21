import json
import re
from collections.abc import Mapping
from typing import Any

from tests.workflows.issue.cases.models import EvidenceRequirement, IssueCase


def _matches_requirements(
    finding: Mapping[str, Any], requirements: list[EvidenceRequirement]
) -> bool:
    rendered = json.dumps(finding, sort_keys=True).lower()
    return all(
        any(re.search(pattern, rendered) for pattern in requirement.any_of)
        for requirement in requirements
    )


def _anchors_at(finding: Mapping[str, Any], locations: list[str]) -> bool:
    finding_locations = {
        location.get("file")
        for location in finding.get("locations", [])
        if isinstance(location, dict)
    }
    return all(location in finding_locations for location in locations)


def _assign_requirements_to_findings(
    candidates: list[list[int]], finding_count: int
) -> list[int] | None:
    """Return one distinct finding index per requirement, or None when no such assignment exists.

    `candidates[i]` lists the findings that can satisfy requirement `i`. A greedy walk is wrong
    here: a broad requirement can match a finding that a later, narrower requirement is the only
    one able to use, and taking it first strands the narrow requirement even though a valid
    one-to-one assignment exists. This is Kuhn's augmenting-path search, which rearranges earlier
    assignments when a later requirement needs a contested finding.
    """
    assigned_finding = [-1] * len(candidates)

    def augment(requirement: int, visited: list[bool]) -> bool:
        for finding in candidates[requirement]:
            if visited[finding]:
                continue
            visited[finding] = True
            if assigned_finding[finding] == -1 or augment(
                assigned_finding[finding], visited
            ):
                assigned_finding[finding] = requirement
                return True
        return False

    for requirement in range(len(candidates)):
        if not augment(requirement, [False] * finding_count):
            return None

    assignment = [-1] * len(candidates)
    for finding, requirement in enumerate(assigned_finding):
        if requirement != -1:
            assignment[requirement] = finding
    return assignment


def assert_issue_case_oracle(
    case: IssueCase, result: Mapping[str, Any]
) -> list[dict[str, Any]]:
    findings = [
        narrative
        for narrative in result.get("narratives", [])
        if isinstance(narrative, dict)
        and narrative.get("verdict") in {"confirmed-defect", "confirmed-vulnerability"}
    ]
    assert findings, result

    matching_findings = [
        finding
        for finding in findings
        if finding.get("verdict") in case.oracle.acceptable_verdicts
        and _matches_requirements(finding, case.oracle.required_evidence)
        and _anchors_at(finding, case.oracle.required_locations)
    ]
    assert matching_findings, findings

    if not case.oracle.required_findings:
        return matching_findings

    # Each required finding must be satisfied by its own narrative. A run that merges two defects
    # into one narrative leaves a requirement without a distinct finding and fails.
    candidates = [
        [
            index
            for index, finding in enumerate(matching_findings)
            if _matches_requirements(finding, requirement.required_evidence)
            and _anchors_at(finding, requirement.required_locations)
        ]
        for requirement in case.oracle.required_findings
    ]
    assignment = _assign_requirements_to_findings(candidates, len(matching_findings))
    if assignment is None:
        unmatched = [
            requirement.label
            for requirement, options in zip(
                case.oracle.required_findings, candidates, strict=True
            )
            if not options
        ]
        raise AssertionError(
            f"{case.id}: findings could not satisfy every required finding"
            f"{f' (no candidate for {unmatched})' if unmatched else ''}: {matching_findings}"
        )

    return [matching_findings[index] for index in assignment]
