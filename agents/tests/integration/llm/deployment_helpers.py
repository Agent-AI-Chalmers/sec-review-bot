import os

import pytest

LLM_TEST_DEPLOYMENT_ENV = "LLM_TEST_DEPLOYMENT"


def llm_test_deployment() -> str:
    # Probe agents keep their own agent_name; this env chooses only the model
    # deployment, so tests do not need fake entries in agent_deployment_bindings.
    deployment = os.environ.get(LLM_TEST_DEPLOYMENT_ENV, "").strip()
    if not deployment:
        pytest.skip(
            f"set {LLM_TEST_DEPLOYMENT_ENV}=<deployment name> to choose the "
            "deployment for this probe agent"
        )
    return deployment
