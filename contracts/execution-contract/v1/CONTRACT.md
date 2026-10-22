# Execution Runtime Contract v1

The Temporal workflow type is `execution-workflow`.

Gateway submits one `ExecutionRequest` JSON object. Worker validates it before preparing input or dispatching review workflows. Unknown fields are rejected so independent implementations cannot silently disagree about envelope semantics.

The `input_data` value is validated separately against the selected workflow's schema in `integration-contract/v6`.
