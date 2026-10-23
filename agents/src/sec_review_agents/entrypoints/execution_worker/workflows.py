"""Workflow and activity registration owned by the Execution Worker."""

from typing import Any

from sec_review_agents.entrypoints.execution_worker.workflow import (
    ExecutionWorkflow,
    prepare_execution_run_activity,
)
from sec_review_agents.memory.extraction_workflow import (
    publish_transcript_bundle_activity,
)
from sec_review_agents.temporal.support import prepare_internal_workflow_activity
from sec_review_agents.workflows.issue.single_agent import (
    IssueSingleAgentWorkflow,
    build_issue_single_agent_result_activity,
    run_issue_single_agent_activity,
)
from sec_review_agents.workflows.issue.two_stage import (
    IssueTwoStageWorkflow,
    build_issue_two_stage_result_activity,
    mitigate_issue_self_check_activity,
)
from sec_review_agents.workflows.issue.workflow import (
    IssueReviewWorkflow,
    analyze_issue_activity,
    archive_issue_feedback_attempt_activity,
    build_issue_review_result_activity,
    mitigate_issue_activity,
    verify_issue_activity,
)
from sec_review_agents.workflows.pull_request.workflow import (
    PullRequestReviewWorkflow,
    analyze_pull_request_activity,
    archive_pull_request_feedback_attempt_activity,
    build_pull_request_review_result_activity,
    mitigate_pull_request_activity,
    verify_pull_request_activity,
)
from sec_review_agents.workflows.repository.workflow import (
    RepositoryCaseProcessingWorkflow,
    RepositoryCaseReviewWorkflow,
    RepositoryDeliveryWorkflow,
    RepositoryDiscoveryWorkflow,
    RepositoryReviewWorkflow,
    RepositoryScanWorkflow,
    analyze_repository_case_activity,
    archive_repository_case_feedback_attempt_activity,
    build_failed_repository_case_cvss_result_activity,
    build_repository_case_result_activity,
    build_repository_delivery_result_activity,
    build_repository_discovery_manifest_activity,
    build_repository_discovery_result_activity,
    build_repository_review_result_activity,
    build_skipped_repository_delivery_result_activity,
    execute_repository_combined_delivery_activity,
    execute_repository_single_deliveries_activity,
    mitigate_repository_case_activity,
    plan_repository_delivery_activity,
    prepare_repository_case_activity,
    prepare_repository_case_review_inputs_activity,
    prepare_repository_delivery_execution_activity,
    scan_repository_discovery_chunk_activity,
    score_repository_case_cvss_activity,
    triage_repository_activity,
    verify_repository_case_activity,
    window_deletion_summary_activity,
)

WORKFLOWS: list[Any] = [
    ExecutionWorkflow,
    IssueReviewWorkflow,
    IssueTwoStageWorkflow,
    IssueSingleAgentWorkflow,
    PullRequestReviewWorkflow,
    RepositoryDiscoveryWorkflow,
    RepositoryScanWorkflow,
    RepositoryCaseProcessingWorkflow,
    RepositoryCaseReviewWorkflow,
    RepositoryDeliveryWorkflow,
    RepositoryReviewWorkflow,
]
ACTIVITIES: list[Any] = [
    prepare_execution_run_activity,
    prepare_internal_workflow_activity,
    analyze_issue_activity,
    mitigate_issue_activity,
    verify_issue_activity,
    archive_issue_feedback_attempt_activity,
    build_issue_review_result_activity,
    build_issue_single_agent_result_activity,
    build_issue_two_stage_result_activity,
    publish_transcript_bundle_activity,
    analyze_pull_request_activity,
    mitigate_pull_request_activity,
    verify_pull_request_activity,
    archive_pull_request_feedback_attempt_activity,
    build_pull_request_review_result_activity,
    mitigate_issue_self_check_activity,
    run_issue_single_agent_activity,
    build_repository_discovery_manifest_activity,
    scan_repository_discovery_chunk_activity,
    build_repository_discovery_result_activity,
    triage_repository_activity,
    window_deletion_summary_activity,
    prepare_repository_case_review_inputs_activity,
    prepare_repository_case_activity,
    analyze_repository_case_activity,
    score_repository_case_cvss_activity,
    build_failed_repository_case_cvss_result_activity,
    mitigate_repository_case_activity,
    verify_repository_case_activity,
    archive_repository_case_feedback_attempt_activity,
    build_repository_case_result_activity,
    plan_repository_delivery_activity,
    prepare_repository_delivery_execution_activity,
    execute_repository_single_deliveries_activity,
    execute_repository_combined_delivery_activity,
    build_repository_delivery_result_activity,
    build_skipped_repository_delivery_result_activity,
    build_repository_review_result_activity,
]

__all__ = ["ACTIVITIES", "WORKFLOWS"]
