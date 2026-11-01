import pytest
from deepagents.backends.protocol import ExecuteResponse

from sec_review_agents.filesystem.docker_listing import parse_directory_listing


@pytest.mark.parametrize(
    "response",
    [
        ExecuteResponse(output="", exit_code=1),
        ExecuteResponse(output="[]", exit_code=0, truncated=True),
        ExecuteResponse(output="not JSON", exit_code=0),
        ExecuteResponse(output='[{"path": 1, "is_dir": false}]', exit_code=0),
        ExecuteResponse(output='[{"path": "/tmp", "is_dir": "false"}]', exit_code=0),
    ],
)
def test_listing_failure_is_not_an_empty_directory(response: ExecuteResponse) -> None:
    result = parse_directory_listing(response, "/workspace")
    assert result.error
    assert result.entries is None
