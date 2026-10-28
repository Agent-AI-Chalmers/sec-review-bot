# Execution Workflow

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

本契约定义 Execution Gateway 与 Execution Worker 共同使用的 Temporal Execution Workflow 输入。

相关文件：

- [v1/CONTRACT.md](v1/CONTRACT.md)：workflow type 与字段语义。
- [v1/execution-workflow-input.schema.json](v1/execution-workflow-input.schema.json)：可执行的结构边界。
- [v1/fixtures](v1/fixtures)：由两端实现共同执行的有效与无效输入。

## 边界

Execution Gateway 在启动 `execution-workflow` 时生成该值。Execution Worker 在准备并分派所选 review workflow 前校验同一个值。嵌套的 `input` 仍由所选 Execution API workflow schema 管理；本 family 只负责 Temporal handoff envelope。

## 执行保障

Execution Gateway 使用 Ajv 校验。Execution Worker 在 workflow 反序列化期间保留原始 Temporal mapping，然后在 input-preparation activity 开始时使用 `jsonschema` 校验，再将其投影为 `ExecutionWorkflowInput`。该 activity 使用 Worker 自有的 preparation timeout，而不使用尚未校验的请求 timeout。两端测试套件都会执行 fixture manifest 中列出的所有案例。Manifest 必须覆盖目录中的每个 JSON fixture，因此新增边界案例时，两端实现必须对其达成一致。
