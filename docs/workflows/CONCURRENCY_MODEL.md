# Workflow Concurrency Model

Language: English | [中文](CONCURRENCY_MODEL.zh.md)

This document explains the system-wide concurrency layers. It is about how runs, workflows, and activities share capacity; repository-review stage concurrency is covered separately in [repository-review/CONCURRENCY_AND_FAILURES.md](repository-review/CONCURRENCY_AND_FAILURES.md).

## Basic Temporal Terms

| Term | Meaning |
| --- | --- |
| workflow | Code that orchestrates work by scheduling activities, starting child workflows, and handling results. |
| workflow execution | A specific execution of a workflow whose execution history is stored by Temporal. |
| child workflow | A workflow started by another workflow, such as processing an individual repository-review case. |
| activity | A unit of concrete work, such as running Analyzer; a failed execution can be attempted again according to its retry policy. |
| workflow task | A task in which a Worker advances workflow orchestration, such as handling an activity completion and scheduling the next step. |
| Worker | A process that polls task queues and executes workflow tasks or activity tasks. |
| task queue | A queue through which Temporal dispatches workflow tasks or activity tasks to Workers. |
| activity slot | A place available for a Worker to execute an activity. For example, 8 slots allow at most 8 activities to execute at the same time. |

## Layers

Concurrency is controlled at three different layers:

- App-submitted runs: each submitted run starts an independent Temporal workflow execution. Different runs can make progress at the same time.
- Workflow fanout: a workflow may intentionally keep several child workflows or activities in flight, usually with a sliding window.
- Worker activity capacity: each worker process has a configured activity concurrency limit.

These layers are related, but they are not the same knob.

## Runs Are Not Activity Slots

The execution gateway starts Temporal workflows for app-submitted runs. Temporal does not treat one whole run as one worker slot. A run is decomposed into workflow tasks, activity tasks, and sometimes child workflows.

<!-- doc-default: TEMPORAL_MEMORY_MAINTENANCE_MAX_CONCURRENT_ACTIVITIES; source=agents/src/sec_review_agents/entrypoints/memory_maintenance_worker/main.py -->
| Setting | Worker | Limit |
| --- | --- | --- |
| `TEMPORAL_EXECUTION_MAX_CONCURRENT_ACTIVITIES` | Execution Worker | Review activities executing concurrently per process. |
| `TEMPORAL_MEMORY_EXTRACTION_MAX_CONCURRENT_ACTIVITIES` | Memory Extraction Worker | Activities executing concurrently per process. |
| `TEMPORAL_MEMORY_MAINTENANCE_MAX_CONCURRENT_ACTIVITIES` | Memory Maintenance Worker | Activities executing concurrently, fixed at `1`. |

These settings limit concurrent activities, not the number of submitted runs that have yet to finish. Multiple runs share Worker activity capacity, as illustrated below.

Execution and memory extraction capacity can grow by adding worker processes that poll their respective queues. Memory maintenance is deliberately different: the integrated deployment runs one non-template service with one activity slot, and does not support adding more maintenance Worker processes.

For example, with `TEMPORAL_EXECUTION_MAX_CONCURRENT_ACTIVITIES=8`:

```text
run-1 currently has 3 activities executing
run-2 currently has 4 activities executing
run-3 currently has 1 activity executing
=> this Worker has reached its activity concurrency limit
```

Those numbers are momentary activity usage. They are not fixed reservations per run. A linear issue review may usually occupy one major activity at a time, while a repository review can fan out chunks, cases, or delivery work and consume more activity capacity.

## Temporal Task Queues

Temporal task queues are execution queues for workflow tasks and activity tasks. They are not a business-level FIFO queue of submitted review runs.

Multiple workers can poll the same task queue. When a worker has capacity, it can pick up more activity tasks. The order in which app-submitted runs finish is not guaranteed to match submission order.

If the product needs strict run-level admission control, model it explicitly, for example with a dispatcher workflow, a service-layer queue, or a durable run table. Do not rely on activity slots to explain run-level fairness.

## Workflow Fanout

Some workflows control their own internal fanout. Repository review is the main example:

- discovery can keep several chunk activities in flight;
- case processing can keep several case child workflows in flight;
- delivery execution can keep several combined delivery activities in flight.

Those workflow-level windows cap how much one run can expand. Worker activity capacity still applies underneath: if all Workers have reached their activity concurrency limits, already-scheduled activities wait on the Temporal side until a worker can execute them.
