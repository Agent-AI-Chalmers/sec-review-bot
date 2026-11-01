import hashlib
import json
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import pytest
from scripts.patcheval import patch_execution
from scripts.patcheval.batch import activate, prepare
from scripts.patcheval.collect_patcheval_patches import collect
from scripts.patcheval.summarize_patcheval_evaluation import (
    collect_costs,
    load_submissions,
)
from scripts.patcheval.workspace_state import dataset_cves, first_workspace_patch
from scripts.token_usage import ModelPrice, PriceIndex, StageUsage, stage_cost
from scripts.token_usage.loading import load_run_usage


@pytest.mark.parametrize(
    "rows", [[], [{}], [{"cve_id": ""}], [{"cve_id": "CVE-2024-1234"}] * 2]
)
def test_invalid_dataset_identity_rejected(tmp_path, rows):
    path = tmp_path / "dataset.json"
    path.write_text(json.dumps(rows))
    with pytest.raises(ValueError):
        dataset_cves(path)


def test_batch_rejects_config_drift_and_uses_private_snapshot(tmp_path, monkeypatch):
    model = tmp_path / "model.toml"
    model.write_text('api_key="private"')
    monkeypatch.setenv("MODEL_PROVIDERS_CONFIG_TOML", str(model))
    monkeypatch.setenv("AGENT_MEMORY_CONSUMPTION_ENABLED", "false")
    dataset = tmp_path / "input.json"
    dataset.write_text('[{"cve_id":"CVE-2024-1234"}]')
    batch = tmp_path / "batch"
    prepare(tmp_path, batch, dataset, 10800, False)
    assert "private" not in (batch / "identity.json").read_text()
    assert (batch / "model.toml").stat().st_mode & 0o077 == 0
    model.write_text("changed")
    with pytest.raises(ValueError, match="configuration changed"):
        prepare(tmp_path, batch, dataset, 10800, False)
    monkeypatch.setenv("AGENT_SKILLS_ENABLED", "unexpected")
    assert activate(batch, tmp_path, skip_final=False) == batch / "dataset.json"
    assert (batch / "model.toml").read_text() == 'api_key="private"'


def materialize(tmp_path: Path, exit_code="0"):
    workspace = tmp_path / ".agent-workspace-patcheval-CVE-2024-1234-TEST"
    from sec_review_agents.cli.local_materialization.common import build_run_paths

    # Follow the runtime path owner rather than reproducing a guessed layout.
    paths = build_run_paths(workspace, "local-run-test")
    run = paths.local_root_path
    patch = paths.artifact_root_path / "mitigator" / "workspace.patch"
    patch.parent.mkdir(parents=True)
    patch.write_text("final patch")
    (run / "exit-code.txt").write_text(exit_code)
    (workspace / "CVE-2024-1234-end-to-end-default").symlink_to(run.name)
    return run, patch


def test_failed_patch_requires_matching_ready_receipt(tmp_path):
    run, patch = materialize(tmp_path, "124")
    assert collect(tmp_path, "TEST") == []
    assert collect(tmp_path, "TEST", include_ready=True) == []
    (run / "patch-execution.json").write_text(
        json.dumps(
            {
                "phase": "patch-ready",
                "patch_sha256": hashlib.sha256(patch.read_bytes()).hexdigest(),
            }
        )
    )
    records = collect(tmp_path, "TEST", include_ready=True)
    assert records[0].execution_status == "exit-124"
    assert records[0].run_dir == str(run)
    patch.write_text("changed")
    assert collect(tmp_path, "TEST", include_ready=True) == []


def test_canonical_patch_ignores_unrelated_stage_files(tmp_path):
    run, patch = materialize(tmp_path)
    unrelated = run / "artifacts" / "aaa" / "workspace.patch"
    unrelated.parent.mkdir()
    unrelated.write_text("wrong")
    assert first_workspace_patch(run) == patch


def test_submission_hash_prevents_costs_for_changed_input(tmp_path):
    (tmp_path / "patcheval-T-manifest.json").write_text(
        json.dumps(
            [
                {
                    "cve": "CVE-2024-1234",
                    "experiment": "end-to-end-default",
                    "patch_sha256": "wrong",
                }
            ]
        )
    )
    (tmp_path / "patcheval-T-end-to-end-default.json").write_text(
        '[{"cve":"CVE-2024-1234","fix_patch":"x"}]'
    )
    with pytest.raises(ValueError, match="hash mismatch"):
        load_submissions(tmp_path, "T", ["end-to-end-default"])


def test_missing_usage_does_not_lower_average_to_zero():
    summaries, details = collect_costs(
        [{"cve": "CVE-2024-1234", "experiment": "end-to-end-default", "run_dir": None}]
    )
    assert summaries["end-to-end-default"].avg_token_k is None
    assert details["end-to-end-default"]["missing_usage_cves"] == ["CVE-2024-1234"]


def test_cache_creation_with_unknown_write_rate_is_unknown():
    stage = StageUsage("analyzer", "test", 100, 0, 100, 0, 100, 0, 1, 1)
    index = PriceIndex({"test": ModelPrice(1, 0.1, 1)}, "now")
    assert stage_cost(stage, index) == (None, None)


def test_ai_turns_include_messages_without_usage(tmp_path):
    trajectory = tmp_path / "analyzer" / "trajectory.jsonl"
    trajectory.parent.mkdir()
    trajectory.write_text(
        json.dumps(
            {"event": "message", "message": {"type": "ai", "content": "no usage"}}
        )
        + "\n"
    )
    run = load_run_usage(tmp_path)
    assert run.ai_message_count == 1
    assert run.ai_messages_with_usage_count == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("retry", [False, True])
async def test_skip_only_verifier_after_last_repair(tmp_path, monkeypatch, retry):
    # Exercise the orchestration with a minimal prepared input, keeping the
    # assertions on stage calls and final verification ownership, not prompts.
    monkeypatch.setattr(patch_execution, "PreparedIssueInput", Mock)
    prepared = Mock(mitigator_artifacts_path=str(tmp_path / "mitigator"))
    request = Mock(prepared_input=prepared)
    patch = Path(prepared.mitigator_artifacts_path) / "workspace.patch"
    patch.parent.mkdir()
    patch.write_text("patch")
    analyze = AsyncMock(return_value="analysis")
    mitigate = AsyncMock(return_value="mitigation")
    verify = AsyncMock(return_value="verification")
    monkeypatch.setattr(patch_execution, "analyze_issue_activity", analyze)
    monkeypatch.setattr(patch_execution, "mitigate_issue_activity", mitigate)
    monkeypatch.setattr(patch_execution, "verify_issue_activity", verify)
    monkeypatch.setattr(
        patch_execution, "should_retry_from_verifier_result", lambda result: retry
    )
    monkeypatch.setattr(
        patch_execution, "feedback_retry_context", lambda **kwargs: Mock(history=[])
    )
    monkeypatch.setattr(
        patch_execution, "archive_issue_feedback_attempt_activity", Mock()
    )
    build = Mock(return_value={})
    monkeypatch.setattr(patch_execution, "build_issue_review_result_activity", build)
    await patch_execution.run_default(
        request, tmp_path, skip_final=True, state={}, started=0
    )
    assert verify.await_count == 1
    assert mitigate.await_count == (2 if retry else 1)
    assert build.call_args.args[-1] == (None if retry else "verification")


def test_cleanup_uses_only_attempt_label(monkeypatch):
    from scripts.patcheval.cleanup import cleanup

    run = Mock(side_effect=[Mock(stdout="container-a\ncontainer-b\n"), Mock()])
    monkeypatch.setattr("scripts.patcheval.cleanup.subprocess.run", run)
    monkeypatch.setattr(
        "scripts.patcheval.cleanup.default_docker_bin", lambda: "docker"
    )
    cleanup("attempt-test")
    assert run.call_args_list[0].args[0] == [
        "docker",
        "ps",
        "-aq",
        "--filter",
        "label=sec-review.run=attempt-test",
    ]
    assert run.call_args_list[1].args[0] == [
        "docker",
        "rm",
        "-f",
        "container-a",
        "container-b",
    ]


def test_partial_usage_price_is_unknown():
    stage = StageUsage("analyzer", "test", 10, 1, 11, 0, 0, 0, 2, 1)
    index = PriceIndex({"test": ModelPrice(1, 0.1, 1)}, "now")
    assert stage_cost(stage, index) == (None, None)


def test_costs_follow_submission_even_when_link_changes(tmp_path):
    run, _ = materialize(tmp_path)
    (run / "experiment-name.txt").write_text("CVE-2024-1234-end-to-end-default")
    trajectory = run / "artifacts" / "mitigator" / "trajectory.jsonl"
    trajectory.write_text(
        json.dumps(
            {
                "event": "message",
                "message": {
                    "type": "ai",
                    "usage_metadata": {
                        "input_tokens": 10,
                        "output_tokens": 2,
                        "total_tokens": 12,
                    },
                },
            }
        )
        + "\n"
    )
    records = [
        {
            "cve": "CVE-2024-1234",
            "experiment": "end-to-end-default",
            "run_dir": str(run),
        }
    ]
    link = run.parent / "CVE-2024-1234-end-to-end-default"
    link.unlink()
    link.symlink_to("some-later-attempt")
    costs, _ = collect_costs(records)
    assert costs["end-to-end-default"].avg_token_k == 0.012


def test_pending_retry_masks_old_success(tmp_path):
    from scripts.patcheval.workspace_state import experiment_state

    run, patch = materialize(tmp_path)
    (run / "patch-execution.json").write_text(
        json.dumps(
            {
                "phase": "patch-ready",
                "patch_sha256": hashlib.sha256(patch.read_bytes()).hexdigest(),
            }
        )
    )
    logs = run.parent / "_logs"
    logs.mkdir()
    (logs / "CVE-2024-1234-end-to-end-default.pending").touch()
    state = experiment_state(
        root=tmp_path, tag="TEST", cve="CVE-2024-1234", experiment="end-to-end-default"
    )
    assert state.status == "missing-exit-code"
    assert state.run_dir is None
    assert collect(tmp_path, "TEST", include_ready=True) == []


def test_execution_digest_ignores_reporting_but_tracks_generation(tmp_path):
    from scripts.patcheval.batch import code_digest

    directory = tmp_path / "scripts/patcheval"
    directory.mkdir(parents=True)
    source = directory / "run_patcheval.py"
    source.write_text("original")
    original = code_digest(tmp_path)
    (directory / "README.md").write_text("updated instructions")
    (directory / "summarize_patcheval_evaluation.py").write_text("report changes")
    assert code_digest(tmp_path) == original
    source.write_text("changed execution")
    assert code_digest(tmp_path) != original


@pytest.mark.asyncio
@pytest.mark.parametrize("strategy", ["default", "single_agent", "two_stage"])
async def test_default_execution_uses_existing_direct_runner(
    tmp_path, monkeypatch, strategy
):
    from scripts.patcheval import run_patcheval

    bundle = Mock(local_root_path=tmp_path, issue_strategy=strategy)
    request = Mock()
    direct = AsyncMock(return_value={"result": "original"})
    special = AsyncMock()
    monkeypatch.setattr(
        run_patcheval, "build_local_workflow_request", Mock(return_value=request)
    )
    select = Mock(return_value=direct)
    monkeypatch.setattr(run_patcheval, "direct_run_for_bundle", select)
    monkeypatch.setattr(run_patcheval, "run_default", special)
    assert await run_patcheval._run_patcheval_issue_bundle(bundle) == {
        "result": "original"
    }
    select.assert_called_once_with(bundle)
    direct.assert_awaited_once_with(request)
    special.assert_not_awaited()
    assert (
        json.loads((tmp_path / "patch-execution.json").read_text())["execution_status"]
        == "completed"
    )


def test_collection_uses_runtime_artifact_root_and_selected_run(tmp_path):
    """Real smoke runs exposed an extra run-id directory assumed by the old fixtures."""
    run, final = materialize(tmp_path)
    initial = final.with_name("workspace.initial.patch")
    initial.write_text("initial patch")
    trajectories = run / "artifacts" / "trajectories"
    trajectories.mkdir()
    (trajectories / "0002-mitigator-initial.jsonl").touch()
    (trajectories / "0004-mitigator-retry-1.jsonl").touch()
    records = {r.experiment: r for r in collect(tmp_path, "TEST")}
    full = records["end-to-end-default"]
    derived = records["end-to-end-lightweight-two-stage"]
    assert full.patch_path == str(final)
    assert derived.patch_path == str(initial)
    assert derived.retry_count_used == 1
    for record in records.values():
        assert record.run_id == run.name
        assert record.run_dir == str(run)
        assert record.execution_status == "complete"


def test_frozen_configuration_forces_offline_sandbox(monkeypatch):
    from scripts.patcheval.batch import configuration_environment

    monkeypatch.setenv("AGENT_DOCKER_NETWORK_MODE", "bridge")
    monkeypatch.setenv("AGENT_MEMORY_CONSUMPTION_ENABLED", "false")
    assert configuration_environment()["AGENT_DOCKER_NETWORK_MODE"] == "none"


@pytest.mark.asyncio
@pytest.mark.parametrize("frozen", [False, True])
async def test_single_case_forces_offline_after_environment_loading(
    tmp_path, monkeypatch, frozen
):
    import os

    from scripts.patcheval import run_patcheval

    monkeypatch.setenv("AGENT_DOCKER_NETWORK_MODE", "bridge")
    monkeypatch.setattr(run_patcheval, "bootstrap_agents_env", lambda: None)
    args = Mock(
        variant="end-to-end-default",
        batch_dir=tmp_path if frozen else None,
        dataset=str(tmp_path / "dataset.json"),
        skip_final_verifier=False,
        container_label=None,
        output_dir=str(tmp_path),
        cve="CVE-2024-1234",
    )
    monkeypatch.setattr(run_patcheval, "parse_args", lambda: args)

    def activate(*args, **kwargs):
        os.environ["AGENT_DOCKER_NETWORK_MODE"] = "bridge"
        return tmp_path / "dataset.json"

    monkeypatch.setattr(run_patcheval, "activate", activate)

    class MaterializationReached(Exception):
        pass

    def materialize(**kwargs):
        assert os.environ["AGENT_DOCKER_NETWORK_MODE"] == "none"
        raise MaterializationReached

    monkeypatch.setattr(run_patcheval, "build_patcheval_issue_bundle", materialize)
    with pytest.raises(MaterializationReached):
        await run_patcheval.main()
