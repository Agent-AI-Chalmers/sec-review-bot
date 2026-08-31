# Workflow Concurrency Model

Language: English | [中文](CONCURRENCY_MODEL.zh.md)

This document explains the system-wide concurrency layers. It is about how runs, workflows, and activities share capacity; repository-review stage concurrency is covered separately in [repository-review/CONCURRENCY_AND_FAILURES.md](repository-review/CONCURRENCY_AND_FAILURES.md).

## Layers

Concurrency is controlled at three different layers:

- App-submitted runs: each submitted run starts an independent Temporal workflow execution. Different runs can make progress at the same time.
- Workflow fanout: a workflow may intentionally keep several child workflows or activities in flight, usually with a sliding window.
- Worker activity capacity: a worker process can execute only a bounded number of activities at once.

These layers are related, but they are not the same knob.

## Runs Are Not Activity Slots

The runner service starts Temporal workflows for app-submitted runs. Temporal does not treat one whole run as one worker slot. A run is decomposed into workflow tasks, activity tasks, and sometimes child workflows.

`TEMPORAL_ACTIVITY_WORKERS` controls the worker-side activity executor size. It means "how many activities this worker process can execute at once", not "how many app-submitted runs may be active."

For example, with `TEMPORAL_ACTIVITY_WORKERS=8`:

```text
run-1 currently has 3 activities executing
run-2 currently has 4 activities executing
run-3 currently has 1 activity executing
=> the worker activity pool is full
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

Those workflow-level windows cap how much one run can expand. Worker activity capacity still applies underneath: if the worker pool is full, already-scheduled activities wait on the Temporal side until a worker can execute them.
