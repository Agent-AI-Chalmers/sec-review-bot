import asyncio
from concurrent.futures import ThreadPoolExecutor

from temporalio.client import Client
from temporalio.worker import Worker

from sec_review_agents.memory.extraction_workflow import (
    MemoryExtractionWorkflow,
    claim_pending_memory_extraction_jobs_activity,
    mark_memory_extraction_job_failed_activity,
    register_memory_extraction_job_activity,
    run_memory_extraction_job_activity,
)
from sec_review_agents.memory.maintenance_workflow import (
    MemoryMaintenanceTriggerWorkflow,
    MemoryMaintenanceWorkflow,
    count_pending_memory_observations_activity,
    run_memory_maintenance_activity,
)
from sec_review_agents.memory.schedule import (
    ensure_configured_memory_schedules,
)
from sec_review_agents.runner.service.workflow import (
    RunnerExecutionWorkflow,
    prepare_runner_run_activity,
)
from sec_review_agents.runner.temporal_config import (
    DEFAULT_TEMPORAL_ADDRESS,
    DEFAULT_TEMPORAL_NAMESPACE,
    DEFAULT_TEMPORAL_TASK_QUEUE,
)
from sec_review_agents.temporal.support import (
    prepare_internal_workflow_activity,
)
from sec_review_agents.utils.env import env_value, parse_int_env
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
)

DEFAULT_ACTIVITY_WORKERS = 8


async def run_worker() -> None:
    client = await Client.connect(
        env_value("TEMPORAL_ADDRESS") or DEFAULT_TEMPORAL_ADDRESS,
        namespace=env_value("TEMPORAL_NAMESPACE") or DEFAULT_TEMPORAL_NAMESPACE,
    )
    task_queue = env_value("TEMPORAL_TASK_QUEUE") or DEFAULT_TEMPORAL_TASK_QUEUE
    await ensure_configured_memory_schedules(
        client,
        task_queue=task_queue,
    )
    with ThreadPoolExecutor(
        max_workers=max(
            1,
            parse_int_env(
                env_value("TEMPORAL_ACTIVITY_WORKERS"),
                DEFAULT_ACTIVITY_WORKERS,
            )
            or DEFAULT_ACTIVITY_WORKERS,
        )
    ) as executor:
        worker = Worker(
            client,
            task_queue=task_queue,
            workflows=[
                RunnerExecutionWorkflow,
                IssueReviewWorkflow,
                IssueTwoStageWorkflow,
                IssueSingleAgentWorkflow,
                PullRequestReviewWorkflow,
                MemoryExtractionWorkflow,
                MemoryMaintenanceTriggerWorkflow,
                MemoryMaintenanceWorkflow,
                RepositoryDiscoveryWorkflow,
                RepositoryScanWorkflow,
                RepositoryCaseProcessingWorkflow,
                RepositoryCaseReviewWorkflow,
                RepositoryDeliveryWorkflow,
                RepositoryReviewWorkflow,
            ],
            activities=[
                prepare_runner_run_activity,
                prepare_internal_workflow_activity,
                analyze_issue_activity,
                mitigate_issue_activity,
                verify_issue_activity,
                archive_issue_feedback_attempt_activity,
                build_issue_review_result_activity,
                build_issue_single_agent_result_activity,
                build_issue_two_stage_result_activity,
                count_pending_memory_observations_activity,
                claim_pending_memory_extraction_jobs_activity,
                mark_memory_extraction_job_failed_activity,
                register_memory_extraction_job_activity,
                run_memory_extraction_job_activity,
                run_memory_maintenance_activity,
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
            ],
            activity_executor=executor,
        )
        await worker.run()


def main() -> None:
    asyncio.run(run_worker())


__all__ = [
    "main",
    "run_worker",
]
