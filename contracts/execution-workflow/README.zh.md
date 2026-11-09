# Execution Workflow

语言：[English](README.md) | 中文

本文为 [README.md](README.md) 的中文译文；如有差异，以英文版为准。

本契约定义 Execution Gateway 提交给 Execution Worker 的 Temporal Execution Workflow 输入。

相关文件：

- [v1/CONTRACT.md](v1/CONTRACT.md)：工作流类型和字段含义。
- [v1/execution-workflow-input.schema.json](v1/execution-workflow-input.schema.json)：用于校验输入结构的 schema。
- [v1/fixtures](v1/fixtures)：两端测试共用的有效和无效输入。

## 约定哪些内容

Execution Gateway 启动 `execution-workflow` 时构造这份输入。Execution Worker 在准备材料和启动所选审查工作流之前，再次校验同一份输入。内部的 `input` 仍按所选 Execution API 工作流的 schema 校验；本契约只规定提交给 Temporal 的外层数据结构。

## 如何校验

Execution Gateway 使用 Ajv 校验。Execution Worker 在工作流反序列化时保留 Temporal 传入的原始映射，在输入准备 activity 开始时使用 `jsonschema` 校验，通过后再转换为 `ExecutionWorkflowInput`。该 activity 使用 Worker 自己配置的准备超时，不使用尚未校验的请求超时。

两端测试都会执行清单中的全部用例。清单必须包含目录中的每个 JSON 测试文件，因此新增用例时，两端实现必须接受或拒绝相同的输入。
