# Real-LLM regression smoke for the shared false-positive precedent prompt.
# It guards the important counterexample: "client-side auth is not an
# enforcement boundary" must not suppress a confirmed server-side authorization
# failure reachable through the same PR.

import json
from pathlib import Path

import pytest

from tests.llm_probe import llm_probe
from tests.workflows.pull_request.cases.loader import load_pull_request_cases
from tests.workflows.pull_request.cases.runner import (
    accepted_narratives,
    run_pull_request_case,
)

pytestmark = [pytest.mark.integration, pytest.mark.llm]


def _case(case_id: str):
    matches = [case for case in load_pull_request_cases() if case.id == case_id]
    if not matches:
        raise AssertionError(f"missing pull request case: {case_id}")
    return matches[0]


PROBE = llm_probe(
    run_env="RUN_LLM_FALSE_POSITIVE_PRECEDENT_INTEGRATION",
    description="real LLM false-positive precedent probe",
    requires_deployment=False,
)


@pytest.mark.skipif(not PROBE.enabled(), reason=PROBE.skip_reason())
@pytest.mark.asyncio
async def test_client_side_auth_precedent_does_not_hide_server_authorization_failure(
    tmp_path: Path,
) -> None:
    result = await run_pull_request_case(
        _case("client-auth-precedent"), run_root=tmp_path
    )

    print(json.dumps(result, indent=2, sort_keys=True))
    assert result["verdict"] == "confirmed-vulnerability"
    assert accepted_narratives(_case("client-auth-precedent"), result)
