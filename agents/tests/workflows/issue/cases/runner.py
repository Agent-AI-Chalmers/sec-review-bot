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

    # Each required finding must be satisfied by its own narrative. Assigning greedily is enough
    # here: requirements are matched against distinct findings, so a run that merges two defects
    # into one narrative leaves a requirement unmatched and fails.
    unassigned = list(matching_findings)
    for requirement in case.oracle.required_findings:
        for index, finding in enumerate(unassigned):
            if _matches_requirements(
                finding, requirement.required_evidence
            ) and _anchors_at(finding, requirement.required_locations):
                unassigned.pop(index)
                break
        else:
            raise AssertionError(
                f"{case.id}: no distinct finding satisfied required finding "
                f"{requirement.label!r}: {matching_findings}"
            )

    return matching_findings
