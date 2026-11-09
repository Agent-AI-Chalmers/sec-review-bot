# Review Runs API

语言：[English](README.md) | 中文

本文为 [README.md](README.md) 的中文译文；如有差异，以英文版为准。

本目录定义 Review Runs 与调用方交换的数据。接口依据人工维护的 [v1/openapi.yaml](v1/openapi.yaml) 生成，包括路由、请求与响应 schema 和鉴权方案。控制台使用脱敏读取接口，GitHub Integration 使用完整读写接口，两者要求不同的凭据。

相关文件：

- [v1/openapi.yaml](v1/openapi.yaml)：OpenAPI 3.1 契约，包括各操作的 `operationId`、请求与响应 schema、鉴权方案和 `components.schemas` 中的业务数据结构。
- [v1/observed-run.schema.json](v1/observed-run.schema.json)：读取接口返回的脱敏运行记录结构。
- [v1/review-run-record.schema.json](v1/review-run-record.schema.json)：协调服务使用的运行记录结构。
- [v1/fixtures](v1/fixtures)：用于测试的输入示例，包括必须拒绝的输入。

输入发布接口要求调用方持有输入准备任务的领取凭据（preparation claim）。调用方先预留内容完整、不可修改的发布意图；中断后可以列出意图，确认对象存在或放弃候选。提交准备结果时，内容必须与已确认存在或已选中的意图完全一致。仍持有准备任务时，可以重复提交相同内容；修改引用、输入或发布上下文会被拒绝。候选记录含存储位置和已准备输入，只供经过认证的服务协调接口使用，不进入控制台的脱敏运行记录。

## 两种运行记录

Review Runs 通过 `observeRun()` 生成供读取接口使用的脱敏记录，通过 `rowToRecord()` 生成协调记录。后者包含 `failure_message`；脱敏记录会移除该字段，因此只有使用 service token 的接口才返回它。

## 调用方可以依赖什么

调用方可以依赖以下内容：

- 脱敏运行记录的字段名和必填要求；
- `source_platform` 标识源码托管平台，用于稳定分组；`connector_id` 标识接收并负责该任务的集成类型与实例命名空间；
- `preparation`、`execution`、`publication` 分别报告准备、执行和发布状态。各自包含 `status`、`started_at`、`finished_at` 和 `updated_at`。其中 `updated_at` 是该组状态最后写入时间，不是阶段起止时间；筛选参数仍使用 `*_status` 命名；
- `notices` 记录某环节失败或需要关注时，应由集成展示给用户的消息。消息按产生时间从早到晚排列，多次独立事件分别保留；
- `execution_statistics` 是可空的用量统计快照，包括统计核对状态、已观察到的模型调用与 token 汇总，以及按流程位置、Agent、服务商和模型分组的统计。问题单元、交付单元、执行轮次、草稿批次和初筛分块等位置字段可以为空，因为多数阶段不涉及这些位置。整个字段为 `null` 表示尚无快照，不代表没有消耗；
- token 总量采用 OpenTelemetry GenAI 口径：`input_tokens` 包含已报告的缓存输入子集，`output_tokens` 包含已报告的推理输出子集。Langfuse 中互不重叠的计费分项会在写入本契约数据前转换成这一口径；
- 各 token 字段可以独立为 `null`，表示无法确定所有已覆盖调用的该项用量，不代表零。`total_tokens` 为输入与输出总量之和；任一项未知时，它也为 `null`。缓存和推理用量是总量的子集，不能重复相加；
- `artifact_storage` 可以不存在；可以是 `unavailable` 或 `failed`，并附带可选的 `error_code` 和 `message`；也可以是 `available`，并包含已保存的执行归档。

## 如何校验

控制台的 `Run` 类型由契约生成，构建时会对照测试数据检查字段集合。测试数据增加、删除或改名字段后，类型不一致就会导致编译失败。这里只比较字段集合：TypeScript 读取 JSON 时会将字符串推断为较宽泛的类型，直接比较值类型可能误拒绝合法测试数据。

字段值由 Review Runs 的 `services/review-runs/test/observed-run-contract.test.ts` 验证：测试按清单校验每份输入，也校验 `observeRun()` 的实际输出。类型和 schema 都来自 `openapi.yaml` 的 `ObservedRun`，无需另外维护一份字段对照。超出枚举的状态、不符合 schema 中 pattern 约束的值或格式错误的时间戳都会让测试失败。

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

- **请求校验错误**：`INVALID_QUERY`、`INVALID_BODY`、`INVALID_PATH_PARAMETER` 分别表示查询参数、请求体和路径参数未通过 schema 校验，返回 HTTP 400 和字符串 `code`。运行列表不接受未声明的查询参数：`listRuns` 将过滤条件定义为 `additionalProperties: false` 的对象，因此未知参数返回 `INVALID_QUERY`。服务端从契约枚举生成 `ERROR_RESPONSE_CODES_FROM_CONTRACT`，不会返回枚举之外的 `ErrorResponse.code`。
- **发布流程错误**：`PUBLICATION_STEP_*` 错误码表示确定的、应停止自动重试的发布失败，定义在 [openapi.yaml](v1/openapi.yaml) 的 `ErrorResponse.code` 中，写入接口以 HTTP 409 和字符串 `code` 返回。Review Runs 从该枚举生成 `PUBLICATION_STEP_ERROR_CODES`；GitHub Integration 为每个码设置 `retry: false`。两侧不一致时，`publication-error-code-alignment.test.ts` 会失败，避免遗漏停止重试规则。
- **不带 `code` 的错误**：每个操作都声明 HTTP 500（`InternalError`）；读取请求体的操作还声明超过 1 MiB 上限时的 HTTP 413（`PayloadTooLarge`）。两者不返回 `code`：内部错误不暴露细节，过大的请求体则在 schema 校验前被拒绝。Spectral 规则 `operation-declares-server-errors` 会检查新增操作是否遗漏这些响应。
- **诊断错误码**：`failure_code` 和执行错误的 `code` 暂不限定为枚举，可以增加新值。
