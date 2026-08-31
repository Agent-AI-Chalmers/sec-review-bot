import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import pytest
from temporalio.testing import WorkflowEnvironment

TEMPORAL_TEST_SERVER_EXISTING_PATH_ENV = "TEMPORAL_TEST_SERVER_EXISTING_PATH"


@asynccontextmanager
async def temporal_time_skipping_environment() -> AsyncIterator[WorkflowEnvironment]:
    """Start Temporal's time-skipping test server, or skip when unavailable locally."""

    existing_path = os.environ.get(TEMPORAL_TEST_SERVER_EXISTING_PATH_ENV)
    try:
        async with await WorkflowEnvironment.start_time_skipping(
            test_server_existing_path=existing_path or None,
        ) as env:
            yield env
    except RuntimeError as error:
        if "Failed starting test server" in str(error):
            pytest.skip(
                "Temporal time-skipping test server is unavailable. "
                f"Set {TEMPORAL_TEST_SERVER_EXISTING_PATH_ENV} to a local test-server binary "
                "or allow the Temporal SDK to download it."
            )
        raise
