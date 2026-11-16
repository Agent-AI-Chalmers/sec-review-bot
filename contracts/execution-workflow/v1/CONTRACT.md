# Execution Workflow Input v1

The Temporal workflow type is `execution-workflow`.

Gateway starts the workflow with one `ExecutionWorkflowInput` JSON object. Worker validates it before preparing the run and starting the selected review workflow. Unknown fields are rejected.

The `input` value carries an Execution API v1 workflow input and is validated against the selected workflow schema in `execution-api/v1`.

The envelope contains only `workflow`, `run_id`, `input`, and `timeout_seconds`.
