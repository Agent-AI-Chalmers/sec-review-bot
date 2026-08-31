# 增量安全扫描策略（Repository Incremental Review Strategy）

语言：[English](REPOSITORY_INCREMENTAL_REVIEW_STRATEGY.md) | 中文

本文是 [REPOSITORY_INCREMENTAL_REVIEW_STRATEGY.md](REPOSITORY_INCREMENTAL_REVIEW_STRATEGY.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

在仓库级定时调度（例如每周 `schedule`）场景下，如果每次都做全量扫描，成本与时延会持续上升。因此需要增量模式。

## 核心语义

增量安全扫描可视为对“最终合并结果”的大型 PR 审查，对象是 `base..head` 时间窗口内的变更集合。

- 主证据面：代码与配置变更本身（`diff` + `changed files`）。
- 辅助证据面：commit 标题、提交信息，仅用于意图校准和误报消歧。
- 沿用 repository-review workflow。

## 模式定义

扫描模式设两种取值：

- `full`：仓库级全量扫描（现有行为）。
- `incremental`：基于 `base..head` 的增量扫描。

在 dispatch payload 中引入：

- `scan_mode`: `"full" | "incremental"`
- `base_sha`: string，增量窗口起点 commit（边界）
- `target_branch`: string，调用方选择的必填 branch/ref 标签
- `head_sha`: string，可选，默认使用 `target_branch` 的当前 commit（边界）

当 `scan_mode=incremental` 时：

- `head_sha = resolve(head_sha || target_branch)`
- `base_sha` 为必填边界，不做“候选优先级回退”。
- `base_sha` 在定时模式下语义固定为“按时间窗口回推得到的边界 commit”。
- 若 `base_sha` 缺失、不可达或无效，直接失败并返回明确错误。

## Materialization 设计

### 目录与产物

相较于全量扫描，多出以下产物：

- `incremental-window/incremental.patch`：`base_sha..head_sha` 的统一 diff
- `incremental-window/changed-files.json`：结构化变更文件列表（状态、重命名、大小等）
- `history/scan-window.json`：增量窗口元信息（base/head、触发来源、时间）
- `history/commits.json`：`base_sha..head_sha` 区间内 commit 摘要

`changed-files.json` 最小结构：

```json
{
  "base_sha": "abc123",
  "head_sha": "def456",
  "files": [
    {
      "path": "src/app.ts",
      "status": "modified",
      "previous_path": null
    }
  ]
}
```

`history/commits.json` 最小结构：

```json
{
  "base_sha": "abc123",
  "head_sha": "def456",
  "commits": [
    {
      "sha": "111aaa",
      "title": "fix(auth): tighten JWT audience check",
      "author": "alice",
      "committed_at": "2026-04-19T08:01:02Z"
    }
  ]
}
```

### `history` 的定位（辅助证据层）

`history` 是可用于分析的辅助证据层；`/workspace` 与 `/incremental-window` 是主证据面。

约束如下：

- `history` 可增强结论，但不能单独决定漏洞成立；
- `incremental` 模式下，`history` 与 `diffs` 均属于必需产物，缺失即失败；
- 报告若引用 `history`，应标注为“辅助上下文来源”。

## Discovery 策略调整

### 扫描范围

当 `scan_mode=incremental` 时，discovery 默认仅扫描：

- `changed-files.json` 中的新增/修改文件；
- 删除文件不扫描，但保留为上下文元信息；
- 重命名文件按新路径扫描，并保留旧路径映射。

### 与 `paths_ignore` 的关系

仍遵守仓库配置 `paths_ignore`。

增量窗口的 `changed_file_count` 写入 `history/scan-window.json`。实际进入 discovery 的文件数仍通过 discovery summary 的 `scannable_file_count`、`scanned_file_count`、`skipped_file_count` 和 `candidate_count` 表达，用于解释“为何本次增量几乎无发现”。

## 调度建议

推荐组合：

- 高频执行 `incremental`（例如每日/每周）
- 低频执行 `full`（例如每月）

原因：

- 增量扫描控制成本并提供快速反馈；
- 全量扫描兜底覆盖跨窗口潜伏问题与历史盲区。

### 定时与手动的窗口语义

- `schedule`（定时增量）：
  - 调用方把 `target_branch` 和 cron `schedule` 发给 GitHub integration HTTP dispatch endpoint；
  - App dispatch resolver 从 `target_branch` 解析 `head_sha`；
  - App dispatch resolver 按 schedule 周期大致回推一个窗口，并选择 cutoff 之前最近的 commit 作为 `base_sha`；
  - 实际扫描窗口为 `base_sha..head_sha`。
- `manual`（手动增量）：
  - 调用方必须显式指定 `base_sha`（`head_sha` 可省略）；
  - 不依赖系统自动时间回推；
  - 适用于定点回放、补扫和对比分析。

## 失败策略（禁止降级）

增量模式采用硬失败策略：

- `incremental` 请求下，不允许自动回退到 `full`
- 不允许静默失败后返回“成功但空结果”

以下场景直接失败（不中途降级到 `full`）：

- 无可用 `base_sha`；
- `base_sha` 不在当前仓库可达历史中；
- diff 生成失败或变更范围异常（例如超大重写）。

失败原因必须显式写入错误日志与作业结果，避免“请求增量，实际按全量执行”的语义漂移。

为什么禁止 `incremental -> full`：

- 从增量退回全量会改变扫描语义与结果范围，造成“请求 - 执行不一致”。
- 这种不一致在安全场景中风险很高：看似完成了增量审查，实际执行了另一套评估边界。
- 因此系统选择“显式失败优于隐式降级”，把语义错误前置暴露给调用方与调度侧。
