# 增量安全扫描策略（Repository Incremental Review Strategy）

语言：[English](REPOSITORY_INCREMENTAL_REVIEW_STRATEGY.md) | 中文

本文是 [REPOSITORY_INCREMENTAL_REVIEW_STRATEGY.md](REPOSITORY_INCREMENTAL_REVIEW_STRATEGY.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

在仓库级定时调度（例如每周 `schedule`）场景下，如果每次都做全量扫描，成本与时延会持续上升。因此需要增量模式。

## 设计思想

给定一个时间窗口，我们就能定出 `base` 和 `head`。这两端之间包含了很多 commit，比较两端则能看到哪些文件被修改、新增、删除、重命名。

那么 discovery 是否一定要读取这些完整变动，才能发现漏洞？并不需要，理由只有一条：

> 改动引入了问题，这个问题就会出现在现在的代码里。到了那时，它和改动本身已经没有关系了。

所以变动只用来做一件事：得知哪些文件被修改。这些被修改的文件就是扫描对象，扫描它们正是增量比全量便宜的地方。证据面是当前代码，窗口只负责决定看哪里。

按这个思路，剩下一件事要安排：窗口判断放在哪。答案是 analyzer。discovery 做单文件判断，一个文件当前长什么样，它就报什么；它看不到窗口，也就不去猜。analyzer 手里本来就有 diff 和其他上下文，判断“线索是不是真的”和“它属不属于这个窗口”代价差不多，真实存在但原先就有的问题在那里被识别出来，不进本次结果。

把窗口归属放在 analyzer 而不是 discovery，是一个有意的成本取舍。让 discovery 自己具备改动感知，等于再建一条 discovery 流水线，连带自己的 prompt 和候选处理，代价很高。

这条路线有一个它自己解决不了的盲区，需要单独补。

### 删除

删掉一个保护，问题不出现在当前代码的“某一行”上，而是表现在“某个东西不在了”。“不在”没有行号可看，而 discovery 只判断一个文件现在长什么样，读不到“这里原本有一道检查，现在没了”。

于是有一类稳定的漏报：

- 删除统一的鉴权 middleware，而所有 route 文件一行未改。route 里本来就没有鉴权逻辑（鉴权在中间件），所以它们在当前代码里和昨天看起来完全一样。
- 删除公共校验函数，调用点未修改。调用处仍在调用，没有任何一行“看起来不安全”。
- 删除 denylist、证书或策略文件，受影响的执行代码没有任何变化。

共同点是：**受影响的代码没有被修改**。上面那条道理在这里失效，因为被“引入”的其实是“保护的缺失”。

补法是把删除文件直接变成 case。删除文件不经过 discovery，也不经过 triage。窗口里的删除按**最近父目录**分组，每个目录生成一个 analyzer case，与其余 case 汇合：

- 现存变更文件：走 `discovery -> triage -> analyzer`；
- 删除文件：确定性生成 deletion case，直接进入 analyzer；
- analyzer 汇合两类，统一判断漏洞是否成立。

这样做成本很低：case 生成不需要模型判断，也不改动任何 discovery、candidate 逻辑；删除天然属于当前窗口，不需要再判断一次范围。

分组用目录而不是数量，是因为目录是仓库自己划的边界：同一目录里一起被删的文件通常属于同一套机制（一个中间件和它旁边的策略），拆开会让 analyzer 为每个文件重复追溯同一批调用方，也看不出它们是一起走的。而按固定数量切片是在断言一个并不存在的相关性。

case 的边界并不完美：`src/`、`config/`、根目录这类宽目录可能混进多个独立机制。

为此设一个总删除文件数上限（200）。超过上限时，**这个窗口的删除审计整体跳过**，不做拆分，也不逐目录挑拣：拆分会让结果看起来审过了，逐目录挑拣则会产生一个残缺但看似完整的结果。窗口是调用方给的，窗口过宽是调用方的选择，系统用它听得懂的结论回应——这次删除规模不适合走增量审查，请缩小窗口。

跳过不影响其他环节：由 triage 产生的普通 case 照常审查。结果里有两项说明这件事：`scan_summary.deleted_file_count` 给出窗口删除了多少文件，`deletion_review_skipped` 说明是否因此整体跳过。删除数放在 scan summary 里，是为了解释一次增量为何发现很少——删除文件本来就不会进入 discovery。

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

窗口内的 commit 标识随 `scan_target.commit_shas` 传递，与 pull request run 一致。commit message 与作者信息不再物化：patch 已经说明了改了什么，而 message 属于作者提供的文本，不提供安全审查可以据以判断的信息。

### `history` 的定位（辅助证据层）

`history` 是可用于分析的辅助证据层；`/workspace` 与 `/incremental-window` 是主证据面。

约束如下：

- `history` 可增强结论，但不能单独决定漏洞成立；
- `incremental` 模式下，`history` 与 `diffs` 均属于必需产物，缺失即失败；
- 报告若引用 `history`，应标注为“辅助上下文来源”。

## Discovery 策略调整

### 扫描范围

当 `scan_mode=incremental` 时，discovery 默认仅扫描：

- `changed-files.json` 中的新增、修改、重命名、复制和类型变更文件；
- 删除文件不扫描：已经没有当前文件可读。删除由 deletion case 单独处理，见上文“设计思想”中的“删除”一节；
- 重命名文件按新路径扫描，并保留旧路径映射。

discovery 不做任何窗口判断。它拿到的是整文件，报的是文件里的发现，与全量扫描一致。线索是否属于这个窗口，由 analyzer 判断。

### 与 `paths_ignore` 的关系

仍遵守仓库配置 `paths_ignore`，对 discovery 的文件选择和 deletion case 都生效。匹配 `paths_ignore` 的删除路径不产生 case，因此删除整棵被忽略的目录不会进入审查。

增量窗口的 `changed_file_count` 写入 `history/scan-window.json`。实际进入 discovery 的文件数仍通过 discovery summary 的 `scannable_file_count`、`scanned_file_count`、`skipped_file_count` 和 `candidate_count` 表达，用于解释“为何本次增量几乎无发现”。

## 调度建议

推荐组合：

- 高频执行 `incremental`（例如每日/每周）
- 低频执行 `full`（例如每月）

原因：

- 增量扫描控制成本并提供快速反馈；
- 全量扫描覆盖从未被任何窗口选中过的文件，并补上增量有意跳过的历史视角。

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
