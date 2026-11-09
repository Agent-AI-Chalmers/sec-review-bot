# 集成契约 v1

语言：[English](CONTRACT.md) | 中文

本文为 [CONTRACT.md](CONTRACT.md) 的中文译文；如有差异，以英文版为准。

代表性的 JSON 测试样例位于 [`fixtures`](fixtures)。Python 和 TypeScript 契约测试都会读取这些测试样例。

本文定义通过 Execution API v1 提交 run 时使用的工作流 `input`，以及 run 完成后返回的 `result`。HTTP 操作与 envelope 由同一 API 版本中的 [OpenAPI 文档](openapi.yaml) 定义。

v1 的公开结果只按工作流暴露最终结果，不暴露内部阶段的运行细节：

- Issue 审查和 PR 审查返回单个 `ReviewRecord`。
- 仓库审查返回 scan 摘要、case-level `ReviewRecord` 投影，以及 repository-only delivery result。

## 1. 工作流输入

本节定义 create-run API（`POST /v1/workflows/{workflow}/runs`，operationId 为 `createRun`）的 request body 中的 workflow `input` 对象。`run_id`、`runtime` 等 HTTP envelope 字段由 [Execution API OpenAPI 文档](openapi.yaml) 定义。

所有工作流输入都包含：

- `api_version: "v1"`
- `input_bundle`
- `review_intent`

### Input Bundle 边界

`input_bundle` 是指向完整输入材料包归档的不可变产物引用。调用方准备并上传归档；Execution Worker 校验后，将其还原到本次 run 专用的本地目录，再读取清单或执行工作流。

v1 Execution Worker 只接受以下规范的 input-bundle URI 形式：

- 本地文件使用 `file:///absolute/path` 或 `file://localhost/absolute/path`；
- 持久 S3 对象使用 `s3://bucket/non-empty-key`。

其他 `file:` 写法（包括 `file:/absolute/path`）会被拒绝。S3 URI 的 authority 只能包含 bucket name，不允许 user information 或 port。两种形式都不允许空白字符、query string 或 fragment。Storage endpoint、region 和 credentials 属于部署配置，绝不能来自工作流输入。带有效期的 HTTP 预签名 URL 不是持久产物引用。

调用方负责输入材料包；Execution Worker 及其阶段负责 `artifact_paths`、阶段产物根目录、可写阶段工作区、重试状态和交付单元分配信息等运行态信息。

`input_bundle` 归档必须符合 [input-bundle artifact v1 profile](../../tar-zstd-artifact/profiles/input-bundle/v1/SPEC.zh.md)。Execution Worker 会校验并将其中声明的路径解析为内部 `bundle_paths`；调用方不得直接提供 `bundle_paths`。

`input_bundle` 的对象结构和规范的 URI 语法由 [`common.schema.json`](schemas/common.schema.json) 定义。

仓库扫描目标（[`repository-review-input.schema.json`](schemas/repository-review-input.schema.json) 中的 `scan_target`）：

- `target_branch` 是调用方选择的 branch/ref 标签。
- `base_sha` / `head_sha` / `commit_shas` 描述扫描变更窗口，对应 PR workflow 的 base/head/commit context。
  - 全量扫描中 `base_sha` 为 `null`、`commit_shas` 为空；
  - 增量扫描中以 `base_sha..head_sha` 为准，`commit_shas` 说明“这个区间里具体有哪些提交”。

仓库扫描范围（同一 schema 中的 `scan_scope`）声明 `paths_ignore` 与 `incremental_changed_files`。

每种工作流输入都有自己的 schema：

| 工作流 | Schema |
| --- | --- |
| `issue-review` | [`issue-review-input.schema.json`](schemas/issue-review-input.schema.json) |
| `pull-request-review` | [`pull-request-review-input.schema.json`](schemas/pull-request-review-input.schema.json) |
| `repository-review` | [`repository-review-input.schema.json`](schemas/repository-review-input.schema.json) |

PR 输入携带 `pr` 对象，描述本次 run 所看到的 PR。其中两个字段的关系无法由 schema 表达，因此需要单独说明：

- `base_sha` 与 `head_sha` 标识 PR 本身，在一次 run 内保持不变。
- `review_window` 说明本次 run 覆盖的范围。`synchronize` 通常只覆盖新推送的提交，因此范围较窄；触发回退条件时，也可能覆盖完整 PR。`review_window.reason` 记录 run 为何回退到完整范围。

Execution API 服务和 Execution Worker 都会在各自的进程边界校验输入。所有工作流都需要这些共同字段：

- `api_version`
- `input_bundle`
- `review_intent`

`review_intent.objective` 声明审查目标：

- `audit`
- `repair`（仅 `issue-review`；PR 和仓库工作流当前要求 `audit`）

`review_intent.test_changes` 是可选字段，用于约束最终修复补丁。省略时默认按 `allow` 处理：

- `allow`：最终修复补丁可以包含合理的测试改动。
- `deny`：最终修复补丁不得包含测试改动；测试只能作为临时验证手段。

`test_changes` 是写给 Agent 的提示词约束，不是程序层面的强制校验；Execution Worker 不会判断哪些仓库路径算测试文件，也不会按路径规则拒绝文件改动。

`setup_declaration` 是可选字符串，携带被审查仓库默认分支上 `.sec-review/setup.yml` 的内容。对于 PR，使用 base 仓库的默认分支，而不是 fork 或 PR head。它是内联的声明文本，不是路径：调用方读取文件后传入其内容。省略表示不执行 Setup 声明步骤。声明会被严格解析，并在 Agent 启动前在沙箱内执行。调用方负责保证声明来源可信，Execution Worker 不会再向仓库核对来源。

`repository-review` 用 `scan_target` 和 `scan_scope` 明确声明扫描成本与覆盖范围。

`scan_mode` 决定窗口形状：

| 模式 | 要求 / 结构 |
| --- | --- |
| `full` | `scan_scope.incremental_changed_files: []`; `base_sha: null`; `commit_shas: []` |
| `incremental` | 输入材料包清单包含 `incremental_window.path`；`base_sha` 是非空字符串且不同于 `head_sha`；`commit_shas` 非空；`scan_scope.incremental_changed_files` 声明变更文件范围，当明确窗口内没有可扫描改动文件时可以为空列表 |

仓库扫描范围用来控制成本和覆盖面，不能由 Execution Worker 猜测：

- 缺失或未知 `scan_mode` 不会默认成 `full`。全量扫描可能扫描整个仓库，成本和耗时都是调用方必须显式承担的决定。
- `incremental` 也不能从缺失配置中推断。调用方必须提供明确的增量窗口与 `scan_scope.incremental_changed_files`。
- `scan_scope` 是必填安全阀，而不是可选优化项；它声明忽略路径和增量变更文件范围。

## 2. 工作流结果

### ReviewRecord

`ReviewRecord` 是 Issue、PR 和仓库工作流共用的审查结果结构。其字段类型与枚举取值由 [`review-record.schema.json`](schemas/review-record.schema.json) 定义。

Issue / PR 结果展示直接使用 `ReviewRecord`。Repository case 的展示使用 case ID，以及 `ReviewRecord` 中的分析、修复、验证和 CVSS 字段。

`ReviewRecord` 汇总工作流对外返回的审查结果，不包含用于观测和调试的运行诊断。

补丁的最终文件内容以 `ReviewRecord.mitigation.file_changes` 为准。展示路径从 `file_changes[].path` 派生，不再存在独立的 `changed_files` 字段。`patch_diff` 是缓存的审查与定位产物，可以从基线文件树和 `file_changes` 重新生成；不能把它当成另一份最终文件内容来源。

`file_changes` 的新增或更新操作使用 Git 文件模式，由 `mode` 字段指定：`100644`（普通文件）、`100755`（可执行文件）或 `120000`（符号链接）。省略 `mode` 表示 `100644`。对于 `120000`，解码后的 `content` 保存链接目标的字节，而不是目标文件的内容；发布时不得解析目标。目标可以是相对路径、绝对路径或不存在的路径，条目自身的 `path` 仍须通过仓库路径校验。删除操作使用不带 `mode` 的 `status: "deleted"`，也适用于删除链接。切换文件模式会替换条目类型。在开始输出 `120000` 前，生产者和发布者必须一起升级；旧消费者可能拒绝新增的枚举值。 Worker 的文本 `patch_diff` 导出要求差异字节为 UTF-8，并明确拒绝非 UTF-8 差异；`file_changes` 支持 base64 并不意味着该导出限制已经消失。

Execution Worker 根据内部阶段输出构造对外结果。构造 `ReviewRecord` 时只保留公开字段：丢弃未知内部字段，将格式错误的可选标量值设为 `null`，并省略列表中格式错误的成员。这些处理只适用于生成可选报告细节；返回完整结果前，仍必须通过对应工作流的完整 schema 校验。

`ReviewRecord` 只记录审查结果，不承载运行时异常。异常按以下方式处理：

- Discovery、Triage、Analyzer、Mitigator、Verifier，以及 delivery / patch synthesis 等阶段出现未处理异常时，workflow run 失败，Execution API 返回结构化执行错误。
- patch synthesis 失败若已被 delivery 层捕获，则记录在 delivery 结果中。

> *CVSS 是报告里展示的可选评分，不是判断本次审查成功或失败的信号。如果仓库 CVSS 评分失败，但 case review 本身已经成功，公开结果中的 `ReviewRecord.cvss` 应为 `null`，失败细节保留在诊断信息和产物中。*

`verification.coverage` 表达当前代码对 `target_claim` 的解决程度，与是否有补丁无关。`full` 表示仓库证据证明问题已经解决、基线已经修好，或该问题在当前代码中不成立；`partial`、`local-only` 和 `misaligned` 表达仍有缺口，`unresolved` 表示证据不足。没有修改时检查基线，是否有补丁由 `mitigation.file_changes` 表达。`coverage` 本身不代表批准交付：还必须有补丁、没有阻断交付的回归证据，且 `next_step=none`。即使当前代码为 `full`，不必要或无关修改的交付问题仍须写入发现及下一步动作。

`target_claim` 是核查目标，`coverage` 是当前代码对该目标的解决程度，`regression` 是回归检查结果，`next_step` 是后续动作。`findings` 记录需要处理的问题，`evidence` 记录核查依据。结果结构变化时，生产者和消费者必须一起升级；已有产物保留为历史记录，不能仅靠改字段名推断新的评估结论。

`verification.regression` 表达聚焦的回归检查、行为兼容性、构建或测试证据是否支持修改后的工作区。它和安全目标覆盖度分离：一个补丁可以完整覆盖被审查的安全主张，同时测试没有运行或回归就绪状态仍未确定。

`verification.next_step` 表达 Verifier 判断后的后续动作：`none` 表示无需后续；`retry-ai` 表示存在明确、可由有限次数的 AI 修复继续修补的补丁缺口；`manual-review` 表示剩余工作需要人审、管理员动作、凭据轮换、历史清理、部署配置或其他非普通工作区补丁能力。

### Issue 审查结果

工作流：`issue-review`

输入仍使用现有 Issue 输入契约，并通过 `review_intent` 表达审查目标。这个工作流中，`review_intent.objective = "repair"` 会改变 Analyzer 的调查立场；Analyzer 的结论不会阻止后续修复和验证阶段运行。

结果结构由 [`issue-review-result.schema.json`](schemas/issue-review-result.schema.json) 定义。

调用方必须从 `review_record` 渲染 Issue 评论、判断是否有补丁、创建 draft PR。发布 draft PR 时，最终文件内容以 `review_record.mitigation.file_changes` 为准。

### PR 审查结果

工作流：`pull-request-review`

结果结构由 [`pull-request-review-result.schema.json`](schemas/pull-request-review-result.schema.json) 定义。

调用方必须从 `review_record` 渲染 PR 评论、判断是否发布修改建议。

### Repository 审查结果

工作流：`repository-review`

Repository review 由 `scan -> case review -> delivery` 组成：

- `scan_summary` 是扫描阶段公开摘要；完整 Discovery / Triage 输出保存在诊断产物中。
- `case_results[].review_record` 是每个 case 的审查结果。
- `deliveries[]` 是 delivery execution 产出的 repository delivery result 和可发布产物。

结果结构由 [`repository-review-result.schema.json`](schemas/repository-review-result.schema.json) 定义。`case_results[]` 通过 `case_id`、`disposition`、`reason` 和 `review_record` 表达 case-level 公开结果。

### Repository 交付单元

`deliveries[]` 条目是仓库结果 schema 中定义的 `RepositoryDelivery` 对象。

调用方发布仓库交付单元 draft PR 时应使用 `RepositoryDelivery`。每个交付单元必须携带生成的 `patch_diff` 和最终 `file_changes`；展示文件路径从 `file_changes[].path` 派生。`file_changes` 是应用文件内容的权威表示；`patch_diff` 是可从交付单元基线与 `file_changes` 重新生成的缓存审查/定位视图，不得用于重建可发布的文件内容。`case_ids` 用于关联顶层 `case_results[]` 中的 case-level review 详情。

### 校验责任

JSON Schema 负责传输结构，包括必填字段、JSON 类型、枚举、带类型标签的不同结构和额外字段策略。消费方必须先校验完整的 v1 结果，再解释其内容；不能通过宽松类型转换（coercion）把非法值变成合法值。

Schema 不代替领域代码。跨字段工作流规则仍由作出决策的工作流负责；消费方继续负责副作用策略，例如安全的仓库路径、GitHub 权限、发布条件和重试行为。

## 3. 兼容性

以下变化属于破坏性变更：

- 删除或重命名工作流。
- 删除 `review_record` 或改变其核心字段语义。
- 删除 `deliveries[]` 或改变 repository delivery result 的核心字段语义。

以下变化不属于破坏性变更：

- 新增可选字段。
- 调整内部 Python 模块路径或阶段实现。
