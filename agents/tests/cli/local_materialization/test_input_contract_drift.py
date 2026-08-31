from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]

LOCAL_INPUT_ADAPTERS = (
    "src/sec_review_agents/cli/local_materialization/issue.py",
    "src/sec_review_agents/cli/local_materialization/pull_request.py",
    "src/sec_review_agents/cli/local_materialization/repository.py",
)

STAGE_ARTIFACT_PATH_KEYS = (
    "analyzer_artifacts_path",
    "cvss_artifacts_path",
    "mitigator_artifacts_path",
    "verifier_artifacts_path",
    "single_agent_artifacts_path",
    "manifest_artifacts_path",
    "discovery_artifacts_path",
    "triage_artifacts_path",
    "cases_artifacts_path",
)


def test_local_input_adapters_only_send_run_level_artifact_roots() -> None:
    for relative_path in LOCAL_INPUT_ADAPTERS:
        source = (PROJECT_ROOT / relative_path).read_text(encoding="utf-8")
        for key in STAGE_ARTIFACT_PATH_KEYS:
            assert (
                key not in source
            ), f"{relative_path} must not materialize agents stage artifact field {key}"
