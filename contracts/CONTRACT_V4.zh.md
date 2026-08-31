# 集成契约 v4

语言：[English](CONTRACT_V4.md) | 中文

本文是 [CONTRACT_V4.md](CONTRACT_V4.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

代表性的 JSON 测试样例位于 [`fixtures/v4`](fixtures/v4)。Python 和 TypeScript 契约测试都会读取这些测试样例。

本文定义通过 runner HTTP API 提交任务时使用的 workflow `input`，以及任务完成后返回的 `result`。HTTP API 见 [Runner HTTP API](RUNNER_HTTP_API.zh.md)。

v4 的公开结果只按 workflow 暴露最终结果，不暴露内部 stage 的运行细节：

- issue review 和 pull request review 返回单个 `ReviewRecord`。
- repository review 返回 scan 摘要、case-level `ReviewRecord` 投影，以及 repository-only delivery 结果。

## 1. Workflow 输入

本节定义 HTTP create-run request body 中的 workflow `input` 对象。`run_id`、`runtime` 等 HTTP envelope 字段由 [Runner HTTP API](RUNNER_HTTP_API.zh.md) 定义。

所有 workflow input 都包含：

- `contract_version: "v4"`
- `input_bundle_uri`
- `review_intent`

### Input Bundle 边界

`input_bundle_uri` 指向调用方提供的 input bundle 根目录。生产集成当前要求该 bundle 在 runner worker 上可读。

这个耦合是明确设计：GitHub App 或 local materializer 负责把 GitHub 上下文准备成本地 workspace、history 和 incremental window；runner 只消费这些材料并执行 workflow。

调用方负责 input bundle；runner / stage 负责 `artifact_paths`、stage artifact roots、writable stage workspaces、retry state 和 delivery assignments 等运行态信息。

bundle 根目录下的 `manifest.json` 必须存在。manifest 声明 bundle 内部材料路径；runner 会把它解析成内部 `bundle_paths`，供 workflow/backend 使用。调用方不得直接提供 `bundle_paths`。

Repository scan target：

```ts
interface RepositoryScanTarget {
  target_branch: string
  default_branch: string
  event_type: 'manual' | 'scheduled'
  scan_mode: 'full' | 'incremental'
  base_sha: string | null
  head_sha: string
  commit_shas: string[]
}
```

- `target_branch` 是调用方选择的 branch/ref 标签。
- `base_sha` / `head_sha` / `commit_shas` 描述 scan delta window，对应 PR workflow 的 base/head/commit context。
  - full scan 中 `base_sha` 为 `null`、`commit_shas` 为空；
  - incremental scan 中以 `base_sha..head_sha` 为准，`commit_shas` 说明“这个区间里具体有哪些 commit”。

Repository scan scope：

```ts
interface RepositoryScanScope {
  max_file_bytes: number
  paths_ignore: string[]
  incremental_changed_files: Array<{
    path: string
    status: string
    previous_path: string | null
  }>
}
```

Review intent：

```ts
interface ReviewIntent {
  objective: 'audit' | 'repair'
  repair_mode?: 'test-changes-allowed' | 'no-test-changes'
}
```

Issue workflow 使用：

```ts
interface IssueReviewInput {
  contract_version: 'v4'
  input_bundle_uri: string
  review_intent: ReviewIntent
  issue: Record<string, unknown>
}
```

Pull request workflow 使用：

```ts
interface PullRequestReviewInput {
  contract_version: 'v4'
  input_bundle_uri: string
  review_intent: ReviewIntent
  pr: Record<string, unknown>
}
```

Repository workflow 使用：

```ts
interface RepositoryReviewInput {
  contract_version: 'v4'
  input_bundle_uri: string
  review_intent: ReviewIntent
  scan_target: RepositoryScanTarget
  scan_scope: RepositoryScanScope
}
```

runner 会在进程边界校验 input。所有 workflow 都需要这些共同字段：

- `contract_version`
- `input_bundle_uri`
- `review_intent`

`review_intent.objective` 声明 review 目标：

- `audit`
- `repair`（仅 `issue-review`；pull request 和 repository workflow 当前要求 `audit`）

`review_intent.repair_mode` 是可选字段，用于约束后续修复阶段。省略时默认按 `test-changes-allowed` 处理：

- `test-changes-allowed`
- `no-test-changes`

`repair_mode` 是写给 agent 的 prompt 约束，不是程序层面的强制校验；runner 不会判断哪些仓库路径算测试文件，也不会按路径规则拒绝文件改动。

除这些共同字段外，各 workflow 还需要：

| workflow | 必填字段 |
| --- | --- |
| `issue-review` | `issue` |
| `pull-request-review` | `pr` |
| `repository-review` | `scan_target`; `scan_scope` |

`repository-review` 用 `scan_target` 和 `scan_scope` 明确声明扫描成本与覆盖范围：

| 对象 | 必填字段 |
| --- | --- |
| `scan_target` | `target_branch`; `default_branch`; `event_type`; `scan_mode`; `base_sha`; `head_sha`; `commit_shas` |
| `scan_scope` | `max_file_bytes`; `paths_ignore`; `incremental_changed_files` |

`scan_mode` 决定窗口形状：

| 模式 | 要求 / 结构 |
| --- | --- |
| `full` | `scan_scope.incremental_changed_files: []`; `base_sha: null`; `commit_shas: []` |
| `incremental` | input bundle manifest 包含 `incremental_window.path`；`base_sha` 是非空字符串且不同于 `head_sha`；`commit_shas` 非空；`scan_scope.incremental_changed_files` 声明 changed-file scope，当明确窗口内没有可扫描改动文件时可以为空列表 |

Repository scan scope 用来控制成本和覆盖面，不能由 runner 猜测：

- 缺失或未知 `scan_mode` 不会默认成 `full`。full scan 可能扫描整个仓库，成本和耗时都是调用方必须显式承担的决定。
- `incremental` 也不能从缺失配置中推断。调用方必须提供明确的增量窗口与 `scan_scope.incremental_changed_files`。
- `scan_scope` 是必填安全阀，而不是可选优化项；它声明文件大小上限、忽略路径和增量 changed-file 范围。

## 2. Workflow 结果

### ReviewRecord

`ReviewRecord` 是 issue、pull request 和 repository workflow 共享的 review 结果结构：

```ts
interface ReviewRecord {
  analysis: {
    verdict: 'no-actionable-finding' | 'inconclusive' | 'plausible-risk' | 'confirmed-defect' | 'confirmed-vulnerability' | null
    overview: string | null
    narratives: Array<Record<string, unknown>>
  }
  mitigation: {
    overview: string | null
    changed_files: string[]
    file_changes: Array<
      | {
          path: string
          status: 'upsert'
          content: string
          content_encoding: 'utf-8' | 'base64'
          mode?: '100644' | '100755'
        }
      | {
          path: string
          status: 'deleted'
        }
    >
    patch_diff: string | null
  }
  verification: {
    overview: string | null
    review_target_claim: string | null
    validation_level: 'static' | 'logic-simulated' | 'runtime-partial' | 'runtime-endpoint' | null
    patch_coverage: 'full' | 'partial' | 'local-only' | 'unresolved' | 'misaligned' | 'no-patch' | 'not-applicable' | null
    regression_status: 'passed' | 'failed' | 'not-run' | 'not-applicable' | 'unresolved' | null
    resolution_next_step: 'none' | 'retry-ai' | 'manual-review' | null
    patch_findings: string[]
    verification_findings: string[]
    residual_risks: string[]
  }
  cvss: {
    outcome: 'scored' | 'not-scored' | 'skipped' | null
    base_score: number | null
    severity: string | null
    vector: string | null
    overview: string | null
    not_scored_reason: string | null
  } | null
}
```

Issue / PR presentation 直接使用 `ReviewRecord`。Repository case presentation 使用 case IDs 以及 `ReviewRecord` 的 analysis、mitigation、verification、CVSS 投影。

`ReviewRecord` 是 workflow 结果投影；运行诊断用于观测和调试 artifacts，不进入 `ReviewRecord`。

运行时异常不属于 `ReviewRecord`。Analyzer / mitigator / verifier / discovery / delivery synthesis 运行失败时，workflow run 应失败，并由 runner HTTP API 返回结构化 runner error；不要在公开结果中发布 stage-level `status="error"`、`unavailable` 或其他兼容性错误投影。

> *CVSS 是报告里展示的可选评分，不是判断本次审查成功或失败的信号。如果 repository CVSS scoring 失败，但 case review 本身已经成功，公开结果中的 `ReviewRecord.cvss` 应为 `null`，失败细节保留在诊断信息和 artifacts 中。*

`verification.patch_coverage="full"` 要求 verifier 对 patch target 给出完整覆盖；partial coverage 仍应视为 unresolved，不进入 repository delivery/draft PR 交付。

`verification.regression_status` 表达聚焦的 regression、行为保持、build 或 test 证据是否支持 patched workspace。它和安全目标覆盖度分离：一个 patch 可以完整覆盖被审查的安全 claim，同时测试没有运行或回归就绪状态仍未确定。

`verification.resolution_next_step` 表达 verifier 判断后的后续动作：`none` 表示无需后续；`retry-ai` 表示存在明确、可由 bounded AI mitigation 继续修补的 patch gap；`manual-review` 表示剩余工作需要人审、管理员动作、凭据轮换、历史清理、部署配置或其他非普通 workspace patch 能力。

### Issue review 结果

Workflow：`issue-review`

输入仍使用现有 issue input contract，并通过 `review_intent` 表达 review intent。这个 workflow 中，`review_intent.objective = "repair"` 会改变 analyzer stance 和 mitigation gate。

核心结果结构：

```ts
interface IssueWorkflowResult {
  contract_version: 'v4'
  review_record: ReviewRecord
}
```

`issue-review-two-stage` 和 `issue-review-single-agent` 是本地评测 / ablation 专用路径，可由 local CLI 启动为 local-only Temporal workflow，但不属于标准公开 runner contract。

调用方必须从 `review_record` 渲染 issue 评论、判断是否有 patch、创建 draft PR。发布 draft PR 时，最终文件内容以 `review_record.mitigation.file_changes` 为准。

### Pull request review 结果

Workflow：`pull-request-review`

核心结果结构：

```ts
interface PullRequestWorkflowResult {
  contract_version: 'v4'
  review_record: ReviewRecord
}
```

调用方必须从 `review_record` 渲染 PR 评论、判断是否发布 suggestions。

### Repository review 结果

Workflow：`repository-review`

Repository review 由 `scan -> case review -> delivery` 组成：

- `scan_summary` 是 scan 阶段公开摘要；完整 discovery / triage 产物保存在 artifacts 中。
- `case_results[].review_record` 是每个 case 的 case-level review 输出。
- `deliveries[]` 是 delivery execution 产出的 repository delivery 结果和可发布产物。

核心结果结构：

```ts
interface RepositoryReviewWorkflowResult {
  contract_version: 'v4'
  scan_summary: ScanSummary
  case_results: RepositoryCaseResult[]
  deliveries: RepositoryDelivery[]
}
```

`ScanSummary`：

```ts
interface ScanSummary {
  scannable_file_count: number
  scanned_file_count: number
  skipped_file_count: number
  candidate_count: number
  case_count: number
  suppressed_candidate_count: number
}
```

`RepositoryCaseResult`：

```ts
interface RepositoryCaseResult {
  case_id: string
  disposition: 'keep' | 'blocked' | string
  reason: string | null
  review_record: ReviewRecord
}
```

`case_results[]` 通过 `case_id`、`disposition`、`reason` 和 `review_record` 表达 case 级公开结果。

GitHub summary renderer 可以从 `case_results[]` 渲染已确认但未达到 delivery gate 的 blocked case。

### Repository deliveries

`RepositoryReviewWorkflowResult.deliveries[]` 包含 `RepositoryDelivery` 条目。

```ts
interface RepositoryDelivery {
  delivery_id: string
  case_ids: string[]
  file_changes: Array<
    | {
        path: string
        status: 'upsert'
        content: string
        content_encoding: 'utf-8' | 'base64'
        mode?: '100644' | '100755'
      }
    | {
        path: string
        status: 'deleted'
      }
  >
}
```

调用方发布 repository delivery draft PR 时应使用 `RepositoryDelivery`。每个 delivery 必须携带最终 `file_changes`；展示文件路径从 `file_changes[].path` 派生。`case_ids` 用于关联顶层 `case_results[]` 中的 case-level review 详情。

## 3. 兼容性

以下变化属于破坏性变更：

- 删除或重命名 workflow。
- 删除 `review_record` 或改变其核心字段语义。
- 删除 `deliveries[]` 或改变 repository delivery result 的核心字段语义。

以下变化不属于破坏性变更：

- 新增可选字段。
- 调整内部 Python 模块路径或 stage implementation。
