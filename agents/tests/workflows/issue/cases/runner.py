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

    matching_findings = []
    for finding in findings:
        if finding.get("verdict") not in case.oracle.acceptable_verdicts:
            continue
        rendered = json.dumps(finding, sort_keys=True).lower()
        if any(
            not any(re.search(pattern, rendered) for pattern in requirement.any_of)
            for requirement in case.oracle.required_evidence
        ):
            continue
        finding_locations = {
            location.get("file")
            for location in finding.get("locations", [])
            if isinstance(location, dict)
        }
        if not all(
            location in finding_locations for location in case.oracle.required_locations
        ):
            continue
        matching_findings.append(finding)

    assert matching_findings, findings
    return matching_findings
