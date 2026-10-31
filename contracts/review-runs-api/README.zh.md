# Review Runs API

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

本族收录 Review Runs 与其调用方交换的形状。单一事实来源是手写的 [v1/openapi.yaml](v1/openapi.yaml)；路由、请求/响应 schema 与安全方案都从它派生。两个凭据不同的面：控制台消费的脱敏读取面，以及 GitHub 集成调用的完整读/写面。

从这些文档开始：

- [v1/openapi.yaml](v1/openapi.yaml)：OpenAPI 3.1 契约——每个操作（带 `operationId`）、它的请求/响应 schema、安全方案，以及 `components.schemas` 里的领域形状。
- [v1/observed-run.schema.json](v1/observed-run.schema.json)：读取响应返回的、已脱敏的形状。
- [v1/review-run-record.schema.json](v1/review-run-record.schema.json)：协调记录的形状。
- [v1/fixtures](v1/fixtures)：可执行示例，包含本契约必须拒绝的形状。

Input publication 操作在 preparation claim 下预约完整不可变提案、列出待恢复提案，并确认对象存在或放弃。Prepared submission 必须完整匹配已存在或已选中的提案。Preparation 仍持有 run 时接受完全相同的提交重放；修改 reference、input 或 publish context 会被拒绝。候选记录包含存储 locator 和 prepared input，因此属于经过认证的 service 协调面，不进入 console 的 observed-run 投影。

## 边界

Review Runs 通过 `observeRun()` 产出每个 observed run，通过 `rowToRecord()` 产出每条记录。记录携带 `failure_message`，而脱敏后的读取形状刻意丢弃了它，因此它只跨越 service token 那条边界。

## 公开边界

消费者可以依赖：

- observed run 的字段名与必填字段；
- `source_platform`：用于稳定聚合的源码托管平台；以及 `connector_id`：admit 并拥有该 run 的 connector 类型与实例命名空间；
- 以嵌套对象报告的三条生命周期轴：脱敏的 `preparation` 摘要，以及 `execution` / `publication`。每组各自报告 `status`、`started_at`、`finished_at` 与该轴的 `updated_at`（最后一次写入时间，不是阶段边界）；用于筛选它们的查询参数沿用既有的 `*_status` 拼写；
- `notices`：当 run 的某个环节失败或需要关注时，应由集成展示给用户的消息。消息按产生时间从早到晚排列；同一 run 发生多次独立事件时会保留多条，不会合并；
- `execution_statistics`：Review Runs 生成的可空统计快照，包含 reconciliation 状态、已观察到的模型调用与 token 汇总，以及流程坐标/agent/provider/model 分组。case、delivery、pass、draft batch 和 discovery chunk 坐标可空，因为多数阶段没有这些坐标。`null` 表示尚无快照记录，不表示零消耗；
- execution statistics 的 token 总量采用 OpenTelemetry GenAI 语义：`input_tokens` 和 `output_tokens` 包含各自已报告的缓存与 reasoning 子集。Langfuse 的互斥计费 bucket 会在进入本 contract 前完成标准化；
- `artifact_storage` 的变体：不存在；状态为 `unavailable` 或 `failed` 的错误变体，可带 `error_code` 与 `message`；或 `available` 且带有已存储的 bundle。

以下不属于本契约：

- 内部存储记录，例如持久化在 Postgres 里的行形状；
- connector-owned preparation input、claim token 和完整 reconciliation identity；
- 控制台为展示而派生的任何内容，例如相对时间或各阶段耗时。

## 执行方式

控制台的 `Run` 类型由契约生成，并由本 fixture 在构建期钉住：如果 fixture 增加、删除或改名了某个字段，控制台会停止编译，直到生成类型与 fixture 重新一致。该检查比较的是**键集合**而不是值，因为 TypeScript 会放宽 JSON 字符串，值层面的赋值会拒绝一个正确的 fixture。

值层面的一半由 Review Runs 在 `review-runs/test/observed-run-contract.test.ts` 中承担：它按 manifest 的声明校验每个 fixture，并校验 `observeRun()` 的真实输出。类型与 schema 的绑定不再需要单独的键集合对照，因为两者都源自契约（`openapi.yaml`）里同一个 `ObservedRun`。因此，schema 枚举之外的某个状态、被破坏的 pattern、或格式错误的 timestamp 都会让测试失败，而不是流到控制台。

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

## 错误码

- **校验错误码** —— `INVALID_QUERY`、`INVALID_BODY`、`INVALID_PATH_PARAMETER` —— 指明请求的哪一部分未通过契约自身的 schema，因此按 `code` 分类的调用方可以区分运行列表过滤器出错、请求体出错、还是路径参数出错。运行列表请求还会对声明的 query 参数做严格校验：未声明的 query 参数会以 `INVALID_QUERY` 被拒绝，而不是被忽略，因为 `listRuns` 把过滤器建模为一个 `additionalProperties: false` 的对象，而非裸参数列表。它们以 HTTP 400 + 字符串 `code` 呈现。服务端把整个 enum 投影为 `ERROR_RESPONSE_CODES_FROM_CONTRACT`，并拒绝发出契约未声明的码，因此信封不会对外宣称一个 [openapi.yaml](v1/openapi.yaml) 的 `ErrorResponse.code` enum 之外的值。
- **控制流错误码** —— Review Runs 作为终态（确定性）发布失败而发出的四个 `PUBLICATION_STEP_*` 码 —— 单一事实来源化在 [openapi.yaml](v1/openapi.yaml) 的 `ErrorResponse.code` enum 里，并在写面上以 HTTP 409 + 字符串 `code` 呈现。服务端的 `PUBLICATION_STEP_ERROR_CODES`（review-runs）是这份 enum 的投影，GitHub 集成为每个码分类为 `retry: false`，因此任一侧新增一个码都会被 `publication-error-code-alignment.test.ts` 捕获，而不是让发布流程永续重试。
- **不带 `code` 的响应** —— 每个操作都声明了内部故障的 HTTP 500（`InternalError`），每个读取请求体的操作还声明了请求体超过 1 MiB 上限的 HTTP 413（`PayloadTooLarge`）。两者都不带 `code`：故障信息刻意不透明，超限的请求体在契约自身的 schema 之前就被拒绝。Spectral 规则（`operation-declares-server-errors`）会让遗漏它们的新操作失败。
- **诊断错误码**（`failure_code`、执行错误 `code`）是开放集合，在词汇稳定之前不做枚举。
