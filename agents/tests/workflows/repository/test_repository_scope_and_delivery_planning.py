import json
import tempfile
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from sec_review_agents.agents.delivery_planning.workbench_state import (
    DeliveryWorkbenchState,
)
from sec_review_agents.delivery_stages.model import DeliveryCaseInput
from sec_review_agents.delivery_stages.planning.agent_passes import (
    _delivery_planning_pass_artifacts_path,
    _planning_cases_for_batch,
    _planning_items,
    _run_delivery_planning_agent_pass,
    run_delivery_planning,
)
from sec_review_agents.delivery_stages.planning.batching import planning_case_id_batches
from sec_review_agents.delivery_stages.planning.input import (
    prepare_delivery_planning_patch_view,
)
from sec_review_agents.delivery_stages.planning.stage import (
    generate_delivery_plan,
)
from sec_review_agents.review_stages.cvss import (
    CVSS_VECTOR_ORDER,
    CvssV4ScoringOutput,
)
from sec_review_agents.review_stages.cvss.stage import (
    is_cvss_v4_scoring_target,
)
from sec_review_agents.workflows.repository.result import (
    build_repository_workflow_result,
)
from sec_review_agents.workflows.repository.workflow import (
    project_repository_case_result_for_delivery,
)
from sec_review_agents.workflows.repository_case.stage import (
    derive_case_disposition,
    should_run_repository_mitigation,
)


class TestRepositoryScopeAndDeliveryPlanning:
    def _confirmed_analysis(self) -> dict:
        return {
            "summary": {
                "title": "Confirmed case",
                "overview": "Analyzer overview",
                "case_id": "case-77",
            },
            "narratives": [
                {
                    "priority": 1,
                    "verdict": "confirmed-vulnerability",
                    "title": "Primary",
                    "description": "description",
                    "vulnerability_type": "path-traversal",
                    "validation_level": "static",
                    "locations": [
                        {"file": "src/server.js", "line": 33, "label": "loc"}
                    ],
                    "flow_review": {
                        "source_facts": ["source"],
                        "sink_facts": ["sink"],
                    },
                    "support_review": {
                        "supported_inferences": [],
                        "proof_gaps": [],
                    },
                    "cwe_mapping": {
                        "cwe_id": "CWE-22",
                        "cwe_name": "Path Traversal",
                        "cwe_rationale": "matches",
                    },
                }
            ],
            "verdict": "confirmed-vulnerability",
        }

    def _no_actionable_analysis(self) -> dict:
        return {
            "summary": {
                "title": "Current case not confirmed",
                "overview": "The trigger case was not confirmed in current code.",
                "case_id": "case-77",
            },
            "narratives": [],
            "verdict": "no-actionable-finding",
        }

    def _input_data(self, root: Path) -> dict:
        local_root = root / "local"
        run_artifacts = local_root / "artifacts" / "run-test"
        (local_root / "workspace").mkdir(parents=True, exist_ok=True)
        return {
            "run_id": "run-test",
            "scan_target": {
                "ref": "main",
                "target_branch": "main",
                "default_branch": "main",
            },
            "input_bundle_root_path": str(local_root),
            "artifact_paths": {"cases": str(run_artifacts / "cases")},
        }

    async def _run_delivery_planning(
        self, input_data: dict, planning_cases: list[dict], **kwargs
    ):
        return await run_delivery_planning(
            delivery_planning_root=Path(input_data["input_bundle_root_path"])
            / "artifacts"
            / "delivery-planning",
            planning_cases=planning_cases,
            **kwargs,
        )

    def _repository_case_result(
        self,
        *,
        case_id: str,
        title: str,
        affected_path: str,
        anchor_line: int,
        verdict: str = "confirmed-vulnerability",
        changed_files: list[str] | None = None,
        patch_coverage: str = "full",
        verification_findings: list[str] | None = None,
    ) -> dict:
        changed_files = changed_files if changed_files is not None else [affected_path]
        return {
            "case_id": case_id,
            "review_record": {
                "strategy": {
                    "name": "default",
                    "stages": ["analysis", "mitigation", "verification"],
                },
                "analysis": {
                    "verdict": verdict,
                    "overview": f"{title} analysis overview.",
                    "residual_risks": [],
                },
                "mitigation": {
                    "overview": f"{title} mitigation overview.",
                    "changed_files": changed_files,
                    "patch_diff": None,
                    "residual_risks": [],
                },
                "verification": {
                    "overview": f"{title} verification overview.",
                    "patch_coverage": patch_coverage,
                    "patch_findings": verification_findings or [],
                    "verification_findings": [],
                    "residual_risks": [],
                },
                "cvss": None,
            },
            "disposition": "keep",
            "reason": "unit-test",
        }

    def test_t1_no_actionable_does_not_enter_mitigation(self) -> None:
        analysis = self._no_actionable_analysis()

        assert analysis["verdict"] == "no-actionable-finding"
        assert analysis["narratives"] == []
        assert not should_run_repository_mitigation(analysis)

    def test_t2_confirmed_case_enters_mitigation(self) -> None:
        analysis = self._confirmed_analysis()

        assert analysis["verdict"] == "confirmed-vulnerability"
        assert len(analysis["narratives"]) == 1
        assert should_run_repository_mitigation(analysis)
        assert is_cvss_v4_scoring_target(analysis)

    def test_t3_no_confirmed_narrative_is_not_promoted_to_mitigation_target(
        self,
    ) -> None:
        analysis = self._no_actionable_analysis()

        assert not is_cvss_v4_scoring_target(analysis)

    def test_confirmed_defect_without_vulnerability_is_not_cvss_scored(self) -> None:
        analysis = {
            "verdict": "confirmed-defect",
            "overview": "Confirmed repository defect without confirmed security impact.",
            "narratives": [
                {
                    "priority": 1,
                    "verdict": "confirmed-defect",
                    "title": "Defect without confirmed vulnerability",
                }
            ],
        }

        assert not is_cvss_v4_scoring_target(analysis)

    def test_cvss_output_accepts_not_scored_without_metrics(self) -> None:
        output = CvssV4ScoringOutput.model_validate(
            {
                "scoring_status": "not-scored",
                "overview": (
                    "Missing USER directive is hardening, not an independently "
                    "exploitable vulnerability."
                ),
                "not_scored_reason": (
                    "The case only amplifies impact after a separate vulnerability "
                    "is exploited."
                ),
            }
        )

        assert output.scoring_status == "not-scored"
        assert output.av is None
        assert output.metric_rationales == []

    def test_cvss_output_rejects_scored_payload_without_all_metrics(self) -> None:
        with pytest.raises(ValueError):
            CvssV4ScoringOutput.model_validate(
                {
                    "scoring_status": "scored",
                    "overview": "Incomplete score.",
                    "AV": "N",
                }
            )

    def test_cvss_output_rejects_not_scored_payload_with_metrics(self) -> None:
        with pytest.raises(ValueError):
            CvssV4ScoringOutput.model_validate(
                {
                    "scoring_status": "not-scored",
                    "overview": "Hardening only.",
                    "not_scored_reason": "No independent exploit path.",
                    "AV": "N",
                }
            )

    def test_cvss_output_accepts_scored_payload_with_all_rationales(self) -> None:
        output = CvssV4ScoringOutput.model_validate(
            {
                "scoring_status": "scored",
                "overview": "Network-reachable endpoint exposes sensitive data.",
                "AV": "N",
                "AC": "L",
                "AT": "N",
                "PR": "N",
                "UI": "N",
                "VC": "L",
                "VI": "N",
                "VA": "N",
                "SC": "N",
                "SI": "N",
                "SA": "N",
                "metric_rationales": [
                    {"metric": metric, "rationale": f"{metric} rationale"}
                    for metric in CVSS_VECTOR_ORDER
                ],
            }
        )

        assert output.scoring_status == "scored"
        assert output.av == "N"
        assert len(output.metric_rationales) == 11

    def test_workflow_result_keeps_cvss_on_case_results(self) -> None:
        case_results: list[dict[str, Any]] = [
            {
                "review_record": {
                    "cvss": {"base_score": 9.8, "severity": "critical"},
                }
            },
            {
                "review_record": {
                    "cvss": {"base_score": 7.4, "severity": "high"},
                }
            },
            {"review_record": {"cvss": None}},
            {
                "review_record": {
                    "cvss": {
                        "outcome": "not-scored",
                        "base_score": None,
                        "severity": None,
                    }
                }
            },
        ]

        result = build_repository_workflow_result(
            discovery_result={},
            triage_result={},
            delivery_result=None,
            case_results=case_results,
        )
        assert len(result["case_results"]) == len(case_results)

    def test_delivery_planning_batch_cases_preserve_input_order(
        self,
    ) -> None:
        planning_cases = [
            {"case_id": "case-a", "changed_files": []},
            {"case_id": "case-b", "changed_files": []},
            {"case_id": "case-c", "changed_files": []},
        ]

        subset = _planning_cases_for_batch(
            planning_cases, ["case-c", "case-a", "missing"]
        )

        assert [item["case_id"] for item in subset] == ["case-a", "case-c"]

    def test_delivery_planning_items_use_generic_payload_shape(self) -> None:
        planning_cases = [
            {
                "case_id": "case-a",
                "overview": " Case A mitigation overview. ",
                "changed_files": ["src/a.ts", ""],
            }
        ]

        assert _planning_items(planning_cases) == [
            {
                "item_id": "case-a",
                "payload": {
                    "overview": "Case A mitigation overview.",
                    "changed_files": ["src/a.ts"],
                },
            }
        ]

    def test_delivery_planning_batches_cases_by_primary_path(self) -> None:
        planning_cases = [
            {
                "case_id": "case-a",
                "changed_files": ["src/api/orders/checkout.ts"],
            },
            {
                "case_id": "case-b",
                "changed_files": ["src/api/auth/login.ts"],
            },
            {
                "case_id": "case-c",
                "changed_files": ["src/api/orders/checkout.ts"],
            },
            {
                "case_id": "case-d",
                "changed_files": ["src/api/auth/login.ts"],
            },
            {
                "case_id": "case-e",
                "changed_files": ["src/api/assets/route.ts"],
            },
            {
                "case_id": "case-f",
                "changed_files": ["src/api/assets/route.ts"],
            },
        ]

        assert planning_case_id_batches(planning_cases, max_batch_size=3) == [
            ["case-e", "case-f"],
            ["case-b", "case-d"],
            ["case-a", "case-c"],
        ]
        assert planning_case_id_batches(planning_cases, max_batch_size=1) == [
            ["case-e"],
            ["case-f"],
            ["case-b"],
            ["case-d"],
            ["case-a"],
            ["case-c"],
        ]

    @pytest.mark.asyncio
    async def test_delivery_planning_metadata_records_single_planning_mode(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            input_data = self._input_data(Path(tempdir))
            planning_cases = [
                {"case_id": "case-a", "changed_files": []},
                {"case_id": "case-b", "changed_files": []},
            ]
            pass_metas: list[dict | None] = []

            def fake_agent_pass(
                *,
                workbench_state: DeliveryWorkbenchState,
                pass_index: int,
                pass_meta: dict | None = None,
                **_kwargs,
            ) -> dict:
                pass_metas.append(pass_meta)
                if pass_index == 0:
                    workbench_state.create_groups(
                        groups=[
                            {
                                "kind": "delivery",
                                "item_ids": ["case-a", "case-b"],
                                "reason": "Combined delivery.",
                            }
                        ]
                    )
                return {"passIndex": pass_index}

            with patch(
                "sec_review_agents.delivery_stages.planning.agent_passes._run_delivery_planning_agent_pass",
                side_effect=fake_agent_pass,
            ):
                result = await self._run_delivery_planning(
                    input_data,
                    planning_cases,
                    planning_mode="single",
                )
            archived_input = json.loads(
                (
                    Path(input_data["input_bundle_root_path"])
                    / "artifacts"
                    / "delivery-planning"
                    / "delivery-planning-input.json"
                ).read_text(encoding="utf-8")
            )

        assert result["metadata"]["planning_mode"] == "single"
        assert result["metadata"]["planning_pass_count"] == 2
        assert result["counts"]["input_case_count"] == 2
        assert result["counts"]["delivery_count"] == 1
        assert result["constraints"]["ok"] is True
        assert pass_metas == [None, {"kind": "refinement"}]
        assert archived_input == {"cases": planning_cases}

    @pytest.mark.asyncio
    async def test_delivery_planning_defaults_to_batched_mode(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            input_data = self._input_data(Path(tempdir))
            planning_cases = [
                {"case_id": "case-a", "changed_files": []},
                {"case_id": "case-b", "changed_files": []},
            ]
            pass_kinds: list[str | None] = []

            def fake_agent_pass(
                *,
                delivery_planning_root: Path,
                workbench_state: DeliveryWorkbenchState,
                planning_cases: list[dict],
                pass_index: int,
                **_kwargs,
            ) -> dict:
                assert delivery_planning_root.name
                pass_meta = _kwargs.get("pass_meta") or {}
                pass_kinds.append(pass_meta.get("kind"))
                if pass_index == 0:
                    workbench_state.create_groups(
                        groups=[
                            {
                                "kind": "delivery",
                                "item_ids": [
                                    case_entry["case_id"]
                                    for case_entry in planning_cases
                                ],
                                "reason": "Batch delivery.",
                            }
                        ]
                    )
                return {"passIndex": pass_index}

            with patch(
                "sec_review_agents.delivery_stages.planning.agent_passes._run_delivery_planning_agent_pass",
                side_effect=fake_agent_pass,
            ):
                result = await self._run_delivery_planning(input_data, planning_cases)

        assert result["metadata"]["planning_mode"] == "batched"
        assert "batch" in pass_kinds
        assert "refinement" in pass_kinds
        assert result["constraints"]["ok"]

    def test_delivery_planning_batch_and_refinement_artifact_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            input_data = self._input_data(Path(tempdir))
            planning_root = (
                Path(input_data["input_bundle_root_path"])
                / "artifacts"
                / "delivery-planning"
            )

            assert (
                _delivery_planning_pass_artifacts_path(
                    planning_root,
                    {"kind": "batch", "index": 2, "count": 3, "max_batch_size": 30},
                )
                == planning_root / "batches" / "batch-0002"
            )
            assert (
                _delivery_planning_pass_artifacts_path(
                    planning_root,
                    {"kind": "refinement"},
                )
                == planning_root / "refinement"
            )
            assert (
                _delivery_planning_pass_artifacts_path(planning_root) == planning_root
            )

    @pytest.mark.asyncio
    async def test_delivery_planning_transcript_uses_batch_subdirectories(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            input_data = self._input_data(Path(tempdir))
            delivery_planning_root = (
                Path(input_data["input_bundle_root_path"])
                / "artifacts"
                / "delivery-planning"
            )

            async def fake_invoke_agent_runtime_graph(**kwargs):
                assert kwargs["transcript_paths"] == (
                    delivery_planning_root
                    / "batches"
                    / "batch-0001"
                    / "transcript.json",
                )
                return {}

            with (
                patch(
                    "sec_review_agents.delivery_stages.planning.agent_passes.create_delivery_planning_agent_graph",
                    return_value=object(),
                ),
                patch(
                    "sec_review_agents.delivery_stages.planning.agent_passes.invoke_agent_runtime_graph",
                    side_effect=fake_invoke_agent_runtime_graph,
                ),
            ):
                await _run_delivery_planning_agent_pass(
                    delivery_planning_root=delivery_planning_root,
                    workbench_state=DeliveryWorkbenchState.initial(["case-1"]),
                    planning_cases=[{"case_id": "case-1"}],
                    pass_meta={
                        "kind": "batch",
                        "index": 1,
                        "count": 2,
                        "max_batch_size": 30,
                    },
                )

    @pytest.mark.asyncio
    async def test_delivery_planning_batched_mode_assembles_batch_drafts_then_refines(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            input_data = self._input_data(Path(tempdir))
            planning_cases = [
                {
                    "case_id": "case-a",
                    "changed_files": ["src/a.ts"],
                },
                {
                    "case_id": "case-b",
                    "changed_files": ["src/a.ts"],
                },
                {
                    "case_id": "case-c",
                    "changed_files": ["src/b.ts"],
                },
                {
                    "case_id": "case-d",
                    "changed_files": ["src/b.ts"],
                },
            ]
            seen_batch_cases: list[list[str]] = []
            refinement_seen_groups: list[dict] = []
            pass_kinds: list[str | None] = []

            def fake_agent_pass(
                *,
                delivery_planning_root: Path,
                workbench_state: DeliveryWorkbenchState,
                planning_cases: list[dict],
                pass_index: int,
                **_kwargs,
            ) -> dict:
                assert delivery_planning_root.name
                pass_meta = _kwargs.get("pass_meta") or {}
                pass_kinds.append(pass_meta.get("kind"))
                case_ids = [case_entry["case_id"] for case_entry in planning_cases]
                if pass_index == 0:
                    seen_batch_cases.append(case_ids)
                    workbench_state.create_group(
                        item_ids=case_ids,
                        reason=f"Batch draft for {','.join(case_ids)}.",
                    )
                else:
                    refinement_seen_groups.extend(
                        workbench_state.read_groups()["groups"]
                    )
                return {"passIndex": pass_index, "case_ids": case_ids}

            with patch(
                "sec_review_agents.delivery_stages.planning.agent_passes._run_delivery_planning_agent_pass",
                side_effect=fake_agent_pass,
            ):
                result = await self._run_delivery_planning(
                    input_data,
                    planning_cases,
                    planning_mode="batched",
                    max_batch_size=2,
                )

        assert sorted(seen_batch_cases) == [
            ["case-a", "case-b"],
            ["case-c", "case-d"],
        ]
        assert pass_kinds.count("batch") == 2
        assert pass_kinds.count("refinement") == 1
        assert len(refinement_seen_groups) == 2
        assert result["constraints"]["ok"]
        assert result["metadata"]["planning_mode"] == "batched"
        assert result["metadata"]["planning_pass_count"] == 3
        assert [item["case_ids"] for item in result["deliveries"]] == [
            ["case-a", "case-b"],
            ["case-c", "case-d"],
        ]

    @pytest.mark.asyncio
    async def test_generate_delivery_plan_fails_when_agent_misses_cases(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            input_data = self._input_data(root)
            captured: dict[str, list[dict]] = {}

            async def run_delivery_planning(**kwargs) -> dict:
                captured["cases"] = kwargs["planning_cases"]
                raise RuntimeError(
                    "delivery workbench state is incomplete after agent execution."
                )

            case_results = [
                self._repository_case_result(
                    case_id="case-1",
                    title="Case 1",
                    affected_path="src/a.ts",
                    anchor_line=1,
                ),
                self._repository_case_result(
                    case_id="case-2",
                    title="Case 2",
                    affected_path="src/b.ts",
                    anchor_line=2,
                ),
            ]
            case_results[0]["review_record"]["mitigation"]["changed_files"] = [
                "src/a.ts"
            ]

            with (
                patch(
                    "sec_review_agents.delivery_stages.planning.stage.run_delivery_planning",
                    side_effect=run_delivery_planning,
                ),
                pytest.raises(RuntimeError, match="workbench state is incomplete"),
            ):
                await generate_delivery_plan(
                    run_artifacts_root=Path(input_data["input_bundle_root_path"])
                    / "artifacts",
                    case_results=[
                        project_repository_case_result_for_delivery(item)
                        for item in case_results
                    ],
                )

            assert not (
                Path(input_data["input_bundle_root_path"])
                / "artifacts"
                / "delivery-planning"
                / "delivery-plan.json"
            ).exists()
            first_case = captured["cases"][0]
            assert first_case["changed_files"] == ["src/a.ts"]
            assert first_case["overview"] == "Case 1 mitigation overview."

    def test_delivery_planning_patch_view_is_materialized_from_case_results(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            run_artifacts_root = root / "artifacts"
            stale_patch = (
                run_artifacts_root / "delivery-planning" / "patches" / "stale.patch"
            )
            stale_patch.parent.mkdir(parents=True)
            stale_patch.write_text("stale\n", encoding="utf-8")
            case_results: list[DeliveryCaseInput] = [
                {
                    "case_id": "case-1",
                    "disposition": "keep",
                    "reason": None,
                    "analyzer_overview": "",
                    "analyzer_verdict": None,
                    "mitigation_overview": "",
                    "mitigator_changed_files": [],
                    "mitigator_file_changes": [],
                    "mitigator_patch_diff": "diff --git a/src/a.ts b/src/a.ts\n",
                    "verifier_overview": "",
                    "verifier_coverage": None,
                    "verifier_patch_findings": [],
                    "verifier_findings": [],
                    "residual_risks": [],
                },
                {
                    "case_id": "case-2",
                    "disposition": "keep",
                    "reason": None,
                    "analyzer_overview": "",
                    "analyzer_verdict": None,
                    "mitigation_overview": "",
                    "mitigator_changed_files": [],
                    "mitigator_file_changes": [],
                    "mitigator_patch_diff": "",
                    "verifier_overview": "",
                    "verifier_coverage": None,
                    "verifier_patch_findings": [],
                    "verifier_findings": [],
                    "residual_risks": [],
                },
            ]

            patch_root = prepare_delivery_planning_patch_view(
                run_artifacts_root=run_artifacts_root,
                case_results=case_results,
            )

            assert not stale_patch.exists()
            assert (patch_root / "case-1.patch").read_text(
                encoding="utf-8"
            ) == "diff --git a/src/a.ts b/src/a.ts\n"
            assert not (patch_root / "case-2.patch").exists()

    def test_case_disposition_reason_is_deterministic(self) -> None:
        analyzer_result = {
            "verdict": "confirmed-vulnerability",
        }
        mitigator_result = {
            "changed_files": ["src/server.js"],
        }
        verifier_result = {
            "overview": "Patch fully covers the target claim.",
            "review_target_claim": "target claim",
            "patch_coverage": "full",
        }
        case_disposition = derive_case_disposition(
            analyzer_result,
            mitigator_result=mitigator_result,
            verifier_result=verifier_result,
        )
        assert case_disposition["disposition"] == "keep"
        assert "passed analyzer" in case_disposition["reason"]
        assert set(case_disposition) == {"disposition", "reason"}

    def test_partial_verifier_coverage_is_confirmed_unresolved(self) -> None:
        analyzer_result = {
            "verdict": "confirmed-vulnerability",
        }
        mitigator_result = {
            "changed_files": ["src/server.js"],
        }
        verifier_result = {
            "overview": "Patch partially covers the target claim.",
            "review_target_claim": "target claim",
            "patch_coverage": "partial",
        }
        case_disposition = derive_case_disposition(
            analyzer_result,
            mitigator_result=mitigator_result,
            verifier_result=verifier_result,
        )
        assert case_disposition["disposition"] == "blocked"
        assert "fully approve" in case_disposition["reason"]
        assert set(case_disposition) == {"disposition", "reason"}

    def test_workflow_result_includes_confirmed_unresolved_case_summaries(self) -> None:
        result = build_repository_workflow_result(
            discovery_result={},
            triage_result={},
            delivery_result=None,
            case_results=[
                {
                    "case_id": "case-1",
                    "disposition": "blocked",
                    "reason": "The verifier did not fully approve the patch.",
                    "review_record": {
                        "analysis": {
                            "verdict": "confirmed-vulnerability",
                            "overview": "User input reaches a raw SQL query.",
                        },
                        "verification": {
                            "patch_coverage": "partial",
                        },
                        "cvss": {"severity": "high", "base_score": 8.1},
                    },
                },
                {
                    "case_id": "case-2",
                    "disposition": "keep",
                    "review_record": {
                        "analysis": {"verdict": "confirmed-vulnerability"}
                    },
                },
            ],
        )

        assert result["case_results"][0]["disposition"] == "blocked"
        assert (
            result["case_results"][0]["review_record"]["analysis"]["verdict"]
            == "confirmed-vulnerability"
        )
