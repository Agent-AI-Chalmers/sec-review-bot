# Execution API

语言：[English](README.md) | 中文

本文为 [README.md](README.md) 的中文译文；如有差异，以英文版为准。

本目录定义完整的对外 Execution API，包括 HTTP 操作、执行输入、工作流结果、错误、`ReviewRecord` 和仓库审查的 `deliveries[]`。这些内容共用一个 API 版本，传输格式和请求、响应的数据 schema 不单独编号。

按需查阅：

- [v1/openapi.yaml](v1/openapi.yaml)：如何创建任务和轮询结果，包括路径、状态码、请求与响应结构、鉴权方式。
- [CONTRACT](v1/CONTRACT.zh.md)：各工作流的输入和结果结构。
- [v1/schemas](v1/schemas)：用于自动校验的 JSON Schema。
- [v1/fixtures](v1/fixtures)：Python 和 TypeScript 测试共用的 JSON 输入示例。

这些文件共同定义 Execution API v1。

## 对外保证哪些内容

调用方可以依赖：

- Execution API 提供的操作；
- HTTP API 接受的工作流名称；
- 当前 `api_version` 对应的执行输入和工作流结果结构；
- 成功与错误响应的结构。

以下内容不属于稳定的对外 API：

- `agents` 下的内部 Python 模块路径；
- Temporal workflow 名称，以及工作流和阶段的实现细节；
- 用于诊断的阶段产物结构，除非其中某字段已明确纳入契约；
- GitHub Integration内部如何安排各步骤；
- 只用于发布策略或本地工具、未纳入契约的字段。

## 双方分别负责什么

调用方负责：

- 准备输入材料包；
- 通过 HTTP 调用工作流；
- 处理结构化结果和错误响应；
- 决定如何展示或发布结果；
- 处理平台特有的发布规则，例如避免重复创建 GitHub PR。

Agent 执行侧负责：

- 执行 Issue、PR 和仓库审查工作流；
- 返回以 `review_record` 和仓库审查的 `deliveries[]` 为核心的结构化结果；
- 保存各种产物。

GitHub Integration是调用方的一种实现：它根据 GitHub 事件准备执行输入，再按平台规则发布结果。

这种分工也限制了权限：GitHub 身份、权限、API 调用、发布、重试和审计由调用方处理。Execution Worker 只执行 Execution API 约定的任务，不直接操作 GitHub。

## 接口定义在哪里

[v1/openapi.yaml](v1/openapi.yaml) 定义 HTTP 操作及请求、响应的外层结构；同版本目录中的 JSON Schema 定义其中携带的各类工作流数据。它们共同维护和发布，不从服务代码反向生成。Execution Gateway 依据这些文件注册路由和校验规则，契约工具也据此生成服务端与调用方的类型。

工具使用 Kubb 从 HTTP 契约生成 TypeScript 类型，再与 v1 工作流输入 schema 组合，使编译器能够检查 `workflow` 与 `input` 是否对应，无需添加共享运行时包。

## 工具

在 `tools/` 中运行：

```bash
pnpm run generate
pnpm run check
pnpm run format:check
pnpm run lint
pnpm run lint:contract
pnpm run typecheck
pnpm test
```

## 执行错误码

调用方可以根据以下稳定的机器可读错误码分别处理失败。未来可以新增错误码，但不会改变已有错误码的含义。尚不能分类的失败使用 `EXECUTION_FAILED`。

- `EXECUTION_REQUEST_INVALID`
- `EXECUTION_WORKFLOW_UNSUPPORTED`
- `EXECUTION_RUN_CONFLICT`
- `EXECUTION_RUN_NOT_FOUND`
- `EXECUTION_RESPONSE_INVALID`
- `EXECUTION_FAILED`

## 兼容性规则

以下修改会破坏兼容性：

- 修改 HTTP 路径或方法；
- 修改某种结果对应的状态码或响应体结构；
- 修改请求、响应或错误响应体中的必填字段；
- 修改工作流名称或输入中的必填字段。

新增接口、接口选项或可选的请求、响应字段，属于非破坏性扩展。

## 如何校验

Schema 将规范中的数据结构规则表达为可执行的校验。当前版本使用 [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)。Python 执行侧使用 [jsonschema](https://python-jsonschema.readthedocs.io/)，TypeScript 集成使用 [Ajv](https://ajv.js.org/)，各自校验输入和结果。两者的测试共用同一批测试数据。

构建 `sec-review-agents` wheel 时会将契约 schema 复制为包数据，因此安装后的 Python 工具不需要访问仓库中的 `contracts/` 目录。

> JSON Schema 无法表达的跨字段约束，例如仓库增量审查的 `base_sha != head_sha`，由运行时输入校验处理。平台发布规则仍由调用方处理：一个路径通过 schema 校验，不代表它一定允许发布到 GitHub 的敏感位置。

运行时解析器还负责 schema 未涵盖的处理和限制，例如枚举值规范化、拒绝不支持的对外字段，以及限制可发布的仓库路径。这些检查补充各使用方的运行时规则，不替代 schema。

## 哪些产物可以供调用方使用

对外结果包括 `review_record`、仓库审查的 `case_results[]`、`deliveries[]`，以及 [CONTRACT](v1/CONTRACT.zh.md) 中列出的其他字段。
