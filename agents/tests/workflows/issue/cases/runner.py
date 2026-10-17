import json
import re
from collections.abc import Mapping
from typing import Any

from tests.workflows.issue.cases.models import IssueCase


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
    assert any(
        finding.get("verdict") in case.oracle.acceptable_verdicts
        for finding in findings
    ), findings

    rendered = json.dumps(findings, sort_keys=True).lower()
    for requirement in case.oracle.required_evidence:
        assert any(re.search(pattern, rendered) for pattern in requirement.any_of), (
            requirement.label,
            findings,
        )

    finding_locations = {
        location.get("file")
        for finding in findings
        for location in finding.get("locations", [])
        if isinstance(location, dict)
    }
    for required_location in case.oracle.required_locations:
        assert required_location in finding_locations, (required_location, findings)

    return findings
