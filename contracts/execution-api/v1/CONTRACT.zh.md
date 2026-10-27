# 集成契约 v1

语言：[English](CONTRACT.md) | 中文

本文是 [CONTRACT.md](CONTRACT.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

代表性的 JSON 测试样例位于 [`fixtures`](fixtures)。Python 和 TypeScript 契约测试都会读取这些测试样例。

本文定义通过 Execution API v1 提交任务时使用的 workflow `input`，以及任务完成后返回的 `result`。HTTP 操作与 envelope 由同一 API 版本中的 [OpenAPI 文档](openapi.yaml) 定义。

v1 的公开结果只按 workflow 暴露最终结果，不暴露内部 stage 的运行细节：

- issue review 和 pull request review 返回单个 `ReviewRecord`。
- repository review 返回 scan 摘要、case-level `ReviewRecord` 投影，以及 repository-only delivery 结果。

## 1. Workflow 输入

本节定义 HTTP create-run request body 中的 workflow `input` 对象。`run_id`、`runtime` 等 HTTP envelope 字段由 [Execution API OpenAPI 文档](openapi.yaml) 定义。

所有 workflow input 都包含：

- `api_version: "v1"`
- `input_bundle`
- `review_intent`

### Input Bundle 边界

`input_bundle` 是指向完整 input bundle archive 的不可变 artifact reference。调用方准备并上传 archive；Execution Worker 校验后，将其 materialize 到 run-scoped 本地目录，再读取 manifest 或执行 workflow。

v1 Execution 支持本地 `file:` 和持久的 `s3:` URI。Storage endpoint、region 和 credentials 属于部署配置，绝不能来自 workflow input。带有效期的 HTTP presigned URL 不是持久 artifact reference。

调用方负责 input bundle；Execution Worker 及其 stage 负责 `artifact_paths`、stage artifact roots、writable stage workspaces、retry state 和 delivery assignments 等运行态信息。

`tar.zst` archive 必须符合 [input-bundle artifact v1 profile](../../tar-zstd-artifact/profiles/input-bundle/v1/SPEC.zh.md)，并包含 `manifest.json`、workspace snapshot、history 和声明的 incremental window。manifest 结构由 [`input-bundle-manifest.schema.json`](schemas/input-bundle-manifest.schema.json) 定义，声明 API version 和 bundle-relative path。Execution Worker 将这些路径解析成内部本地 `bundle_paths`。调用方不得直接提供 `bundle_paths`。

`input_bundle` 的对象结构由 [`common.schema.json`](schemas/common.schema.json) 定义；`uri` 接受 `file:` 或 `s3:` 引用。

Repository scan target（[`repository-review-input.schema.json`](schemas/repository-review-input.schema.json) 中的 `scan_target`）：

- `target_branch` 是调用方选择的 branch/ref 标签。
- `base_sha` / `head_sha` / `commit_shas` 描述 scan delta window，对应 PR workflow 的 base/head/commit context。
  - full scan 中 `base_sha` 为 `null`、`commit_shas` 为空；
  - incremental scan 中以 `base_sha..head_sha` 为准，`commit_shas` 说明“这个区间里具体有哪些 commit”。

Repository scan scope（同一 schema 中的 `scan_scope`）声明 `paths_ignore` 与 `incremental_changed_files`。

每种 workflow input 都有自己的 schema：

| Workflow | Schema |
| --- | --- |
| `issue-review` | [`issue-review-input.schema.json`](schemas/issue-review-input.schema.json) |
| `pull-request-review` | [`pull-request-review-input.schema.json`](schemas/pull-request-review-input.schema.json) |
| `repository-review` | [`repository-review-input.schema.json`](schemas/repository-review-input.schema.json) |

Pull request input 携带 `pr` subject，描述本次 run 所看到的 pull request。其中两个字段的关系无法由 schema 表达，因此需要单独说明：

- `base_sha` 与 `head_sha` 标识 pull request 本身，在一次 run 内保持不变。
- `review_window` 说明本次 run 覆盖的范围。`synchronize` 下它窄于 `base_sha..head_sha`，因为该 run 只覆盖上次审查后推送的提交。`review_window.reason` 记录 run 为何回退到完整范围。

Execution API provider 和 Execution Worker 都会在各自的进程边界校验 input。所有 workflow 都需要这些共同字段：

- `api_version`
- `input_bundle`
- `review_intent`

`review_intent.objective` 声明 review 目标：

- `audit`
- `repair`（仅 `issue-review`；pull request 和 repository workflow 当前要求 `audit`）

`review_intent.test_changes` 是可选字段，用于约束最终 mitigation patch。省略时默认按 `allow` 处理：

- `allow`：最终 mitigation patch 可以包含合理的测试改动。
- `deny`：最终 mitigation patch 不得包含测试改动；测试只能作为临时验证手段。

`test_changes` 是写给 agent 的 prompt 约束，不是程序层面的强制校验；Execution Worker 不会判断哪些仓库路径算测试文件，也不会按路径规则拒绝文件改动。

`setup_declaration` 是可选字符串，携带仓库的 setup 声明（即 base repo 默认分支上 `.sec-review/setup.yml` 的内容）。它是内联的声明文本，不是路径：调用方读取文件后传入其内容。省略表示环境不做引导。声明会被严格解析，并在 agent 启动前在沙箱内执行。来源可信性由调用方负责：它来自 base repo 默认分支，Execution Worker 不会再去核对来源。

`repository-review` 用 `scan_target` 和 `scan_scope` 明确声明扫描成本与覆盖范围。

`scan_mode` 决定窗口形状：

| 模式 | 要求 / 结构 |
| --- | --- |
| `full` | `scan_scope.incremental_changed_files: []`; `base_sha: null`; `commit_shas: []` |
| `incremental` | input bundle manifest 包含 `incremental_window.path`；`base_sha` 是非空字符串且不同于 `head_sha`；`commit_shas` 非空；`scan_scope.incremental_changed_files` 声明 changed-file scope，当明确窗口内没有可扫描改动文件时可以为空列表 |

Repository scan scope 用来控制成本和覆盖面，不能由 Execution Worker 猜测：

- 缺失或未知 `scan_mode` 不会默认成 `full`。full scan 可能扫描整个仓库，成本和耗时都是调用方必须显式承担的决定。
- `incremental` 也不能从缺失配置中推断。调用方必须提供明确的增量窗口与 `scan_scope.incremental_changed_files`。
- `scan_scope` 是必填安全阀，而不是可选优化项；它声明忽略路径和增量 changed-file 范围。

## 2. Workflow 结果

### ReviewRecord

`ReviewRecord` 是 issue、pull request 和 repository workflow 共享的 review 结果结构。其字段类型与 enum 取值由 [`review-record.schema.json`](schemas/review-record.schema.json) 定义。

Issue / PR presentation 直接使用 `ReviewRecord`。Repository case presentation 使用 case IDs 以及 `ReviewRecord` 的 analysis、mitigation、verification、CVSS 投影。

`ReviewRecord` 是 workflow 结果投影；运行诊断用于观测和调试 artifacts，不进入 `ReviewRecord`。

`ReviewRecord.mitigation.file_changes` 是补丁状态的权威来源。展示路径从 `file_changes[].path` 派生，不再存在独立的 `changed_files` 字段。`patch_diff` 是缓存的审查与定位产物，可以从基线文件树和 `file_changes` 重新生成；不能把它当成另一份最终文件内容来源。

Execution Worker 根据内部 stage 输出生产这份投影。`ReviewRecord` builder 会有意只保留公开字段：未知内部字段会被丢弃，格式错误的可选 scalar 会变成 `null`，list 中格式错误的成员会被省略。这项降级策略只适用于生产可选报告细节；完整公开结果在跨越 Execution API 边界前仍必须通过完整 workflow result schema 校验。

运行时异常不属于 `ReviewRecord`。Analyzer / mitigator / verifier / discovery / delivery synthesis 运行失败时，workflow run 应失败，并由 Execution API 返回结构化 execution error；不要在公开结果中发布 stage-level `status="error"`、`unavailable` 或其他兼容性错误投影。

> *CVSS 是报告里展示的可选评分，不是判断本次审查成功或失败的信号。如果 repository CVSS scoring 失败，但 case review 本身已经成功，公开结果中的 `ReviewRecord.cvss` 应为 `null`，失败细节保留在诊断信息和 artifacts 中。*

`verification.patch_coverage="full"` 要求 verifier 对 patch target 给出完整覆盖；partial coverage 仍应视为 unresolved，不进入 repository delivery/draft PR 交付。

`verification.regression_status` 表达聚焦的 regression、行为保持、build 或 test 证据是否支持 patched workspace。它和安全目标覆盖度分离：一个 patch 可以完整覆盖被审查的安全 claim，同时测试没有运行或回归就绪状态仍未确定。

`verification.resolution_next_step` 表达 verifier 判断后的后续动作：`none` 表示无需后续；`retry-ai` 表示存在明确、可由 bounded AI mitigation 继续修补的 patch gap；`manual-review` 表示剩余工作需要人审、管理员动作、凭据轮换、历史清理、部署配置或其他非普通 workspace patch 能力。

### Issue review 结果

Workflow：`issue-review`

输入仍使用现有 issue input contract，并通过 `review_intent` 表达 review intent。这个 workflow 中，`review_intent.objective = "repair"` 会改变 analyzer 的调查立场；下游是否进入 mitigation 仍只由 analyzer 的结构化结果决定。

结果结构由 [`issue-review-result.schema.json`](schemas/issue-review-result.schema.json) 定义。

`two-stage` 和 `single-agent` 两种 issue 策略（本地 issue CLI 的 `--strategy`）是本地评测 / ablation 专用路径：它们在 `issue-review` workflow 上作为 local-only Temporal workflow 启动，但不属于 Execution API v1。

调用方必须从 `review_record` 渲染 issue 评论、判断是否有 patch、创建 draft PR。发布 draft PR 时，最终文件内容以 `review_record.mitigation.file_changes` 为准。

### Pull request review 结果

Workflow：`pull-request-review`

结果结构由 [`pull-request-review-result.schema.json`](schemas/pull-request-review-result.schema.json) 定义。

调用方必须从 `review_record` 渲染 PR 评论、判断是否发布 suggestions。

### Repository review 结果

Workflow：`repository-review`

Repository review 由 `scan -> case review -> delivery` 组成：

- `scan_summary` 是 scan 阶段公开摘要；完整 discovery / triage 产物保存在 artifacts 中。
- `case_results[].review_record` 是每个 case 的 case-level review 输出。
- `deliveries[]` 是 delivery execution 产出的 repository delivery 结果和可发布产物。

结果结构由 [`repository-review-result.schema.json`](schemas/repository-review-result.schema.json) 定义。`case_results[]` 通过 `case_id`、`disposition`、`reason` 和 `review_record` 表达 case 级公开结果。

GitHub summary renderer 可以从 `case_results[]` 渲染已确认但未达到 delivery gate 的 blocked case。

### Repository deliveries

`deliveries[]` 条目是 repository result schema 中定义的 `RepositoryDelivery` 对象。

调用方发布 repository delivery draft PR 时应使用 `RepositoryDelivery`。每个 delivery 必须携带生成的 `patch_diff` 和最终 `file_changes`；展示文件路径从 `file_changes[].path` 派生。`file_changes` 是应用文件内容的权威表示；`patch_diff` 是可从 delivery 基线与 `file_changes` 重新生成的缓存审查/定位视图，不得用于重建可发布的文件内容。`case_ids` 用于关联顶层 `case_results[]` 中的 case-level review 详情。

### 校验责任

JSON Schema 负责传输结构，包括必填字段、JSON type、enum、tagged variant 和额外字段策略。消费方必须先校验完整的 v1 result，再解释其内容；不能通过宽松类型转换（coercion）把非法值变成合法值。

Schema 不代替领域代码。跨字段 workflow 规则仍由作出决策的 workflow 负责；消费方继续负责副作用策略，例如安全的 repository path、GitHub 权限、发布条件和重试行为。

## 3. 兼容性

以下变化属于破坏性变更：

- 删除或重命名 workflow。
- 删除 `review_record` 或改变其核心字段语义。
- 删除 `deliveries[]` 或改变 repository delivery result 的核心字段语义。

以下变化不属于破坏性变更：

- 新增可选字段。
- 调整内部 Python 模块路径或 stage implementation。
