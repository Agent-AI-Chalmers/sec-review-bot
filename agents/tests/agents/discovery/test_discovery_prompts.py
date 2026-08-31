import json

from sec_review_agents.agents.discovery.prompts import (
    build_repository_discovery_user_prompt,
)


def test_discovery_prompt_exposes_chunk_runtime_boundary() -> None:
    prompt = build_repository_discovery_user_prompt(
        chunk={
            "chunk_id": "discovery-chunk-0001",
            "entries": [
                {"path": "src/app.ts", "language": "typescript", "size_bytes": 123}
            ],
        },
        scan_virtual_path="/scan-target",
        sources={"src/app.ts": "console.log('hi')"},
    )

    json_block = prompt.split("```json", 1)[1].split("```", 1)[0]
    scan_target = json.loads(json_block.strip())

    assert scan_target["scan_path"] == "/scan-target"
    assert scan_target["chunk_id"] == "discovery-chunk-0001"
    assert scan_target["files"][0]["path"] == "src/app.ts"
