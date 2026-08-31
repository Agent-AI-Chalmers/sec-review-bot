# Repository Review Strategy

语言：[English](REPOSITORY_REVIEW_STRATEGY.md) | 中文

本文是 [REPOSITORY_REVIEW_STRATEGY.md](REPOSITORY_REVIEW_STRATEGY.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

## Scope

`repository-review` 是一条独立于 `issue-review` 和 `pull-request-review` 的仓库级工作流。它会扫描仓库，把文件级可疑点收束成少量高价值的问题簇，后文称为 `case`。值得处理的 `case` 会进入 `analyzer / cvss-v4-scoring / mitigator / verifier`，最终发布仓库级 summary 和少量 draft PR。

这条 workflow 优先追求初筛覆盖、后置去噪与问题收束，以及 reviewer 可以审查的最终输出。它不是“单 agent 理解完整仓库”的设计，也不追求最大化 finding 数量。

## Stage Model

工作流按三段组织：

1. `scan / case formation`：`discovery -> triage`
2. `per-case review`：对每个 retained `case` 执行 `analyzer / cvss-v4-scoring / mitigator / verifier`
3. `delivery`：`delivery-planning -> delivery-execution`，随后由 GitHub App 发布 summary 和 draft PR

其中 `cvss-v4-scoring` 与同 case 的 mitigation / verification 路径并行执行；delivery execution 会为 `combined` delivery 调用 patch-synthesis 子模块。

## Stage Intent

### `discovery`

discovery 采用局部 chunk 初筛，而不是让 agent 在整个仓库里自由探索。

文件会按路径邻近和上下文预算打成 chunk。每个 chunk 调用一次模型，并产出对应候选。chunk 包含一组相邻文件，足以让 discovery 看到局部跨文件线索，但不会变成全仓上下文。

discovery 产出结构化 `candidate`，包括位置、category、理由和置信度。它不直接确认漏洞，也不做 `vulnerability_type` / `CWE` 分类，以保持高召回和轻量输入。

它负责初筛覆盖，不负责最终确认、跨文件根因合并或报告生成。

### `triage`

`triage` 位于 `discovery` 之后、`analyzer` 之前，负责把高召回的文件级 candidate 去噪并收束成少量高价值 case。

triage 基于仓库可观察证据，决定哪些候选应被保留、抑制或合并。合并表示这些候选描述的是同一个可观察安全问题，而不是宽泛的同类模式。

它不应仅因为同文件、同路由或同类漏洞而过度合并，也不应仅因为行为被文档描述、带有 internal/debug/legacy 语义，或存在不完整 guard，就过早 suppress。只有值得继续分析的 case 会进入 analyzer。

### `analyzer`

只有经过 `triage` 保留下来的 `case` 才进入 `analyzer`。该阶段复用 narrative-first 思路，输出按 `priority` 排序的 narratives、location、source facts、sink facts、proof gaps，以及漏洞类型/CWE 分类和 reviewer-facing summary。

analyzer 会先把候选线索提升为有证据支撑的结论，然后 mitigation 或 delivery 才开始。mitigation 不应建立在模糊 suspicion 上。

`analyzer` 必须遵守 case scope 边界：

- 可以确认、缩窄或否定当前 case；
- 但不能把当前 case 改写成另一个独立问题并沿用原 `case_id` 继续推进；
- 邻近独立问题不得进入当前 case 的 `narratives`，也不进入当前 case 的 mitigation / verification / delivery execution。

### `cvss-v4-scoring`

`cvss-v4-scoring` 位于 `analyzer` 之后，负责基于 analyzer facts 做 CVSS v4 Base 指标判定，并输出标准化 `vector / base_score / severity`。分数用于报告层风险表达，不作为主要调度或修复优先级信号。

该阶段只在当前 case 范围内做定向事实核实和标准化打分，不重新判断 analyzer 的漏洞结论，也不使用修复后的状态信息。

### `mitigator`

`mitigator` 服务于高置信、已收敛的问题。patch 应尽量贴近真正边界或 sink，范围小，并且便于 reviewer 独立审查。broad discovery、自由探索式再分析和大范围重构不属于这个阶段。

### `verifier`

`verifier` 负责独立复核 analyzer 和 mitigator 输出。它检查 analyzer 是否过度表述，patch 是否真正修到点上，以及 patch 是否引入明显副作用或绕过。

在 repository review 路径里，`verifier` 同时检查报告和 patch，并为 keep/blocked 决策提供最后一道质量门槛。

为降低“mitigation 报告声称已应用，但 verifier 看到 baseline 代码而误判未应用”的风险，repository verifier 使用双视角输入：

- `/workspace`：baseline 只读视角（未打补丁）；
- `/workspace-patched`：在 verifier 阶段临时构建的只读视角（将 `workspace.patch` 应用到 clean workspace snapshot 后得到）。

当 `workspace.patch` 存在且可应用时，`patch_coverage` 主要基于 `/workspace-patched` 判断，`/workspace` 仅作为基线对照。若 patched 视角构建失败，verification 会失败，而不是基于 baseline 代码判断补丁覆盖。

### `delivery-planning`

只有 verified 的 case 会进入 delivery-planning / delivery-execution。

`delivery-planning` 把 verified cases 分组成 delivery units。它的主要事实来自 prepared per-case 产物，而不是共享 workspace 最终态。它优先依赖 case item payload、mitigation overview、changed files 和 workbench state；只有这些输入无法解释某个交付耦合问题时，才读取 per-case patch。

合并原则只看交付是否必须绑定同一 PR，而不是 case 在语义上是否相关。只有需要协调执行、共享 patch 范围、存在发布依赖或分开发会产生执行冲突时才建 `combined` delivery；否则保持 `single`。delivery execution 消费该计划并产出公开 delivery result，app 只消费结果，不反推合并策略。

### `delivery-execution`

delivery execution 接收 `delivery-planning` 的计划，并产出 GitHub app 可以发布的产物。`single` delivery 会整理单个 case 已经产生的文件改动；`combined` delivery 会调用 patch-synthesis 子模块，生成一组协调后的最终文件状态。

实现顺序是固定的：

1. 基于 delivery-planning 约束确定 delivery 执行单元；
2. 对 `combined` delivery 调用 patch-synthesis 子模块；
3. 组装 delivery result，只写入实际可发布的 delivery 产物。

delivery execution 按 delivery strategy 分两种路径：

- `single`：不调用 agent，不进入 patch synthesis 并发池，也不重新应用或复制 case `workspace.patch`。它直接消费对应 case 的 `review_record.mitigation.file_changes`，投影为可发布 delivery 产物；若没有可发布 `file_changes`，该 delivery 不写入 public `deliveries[]`。
- `combined`：调用 patch-synthesis agent，在隔离的 clean workspace 中消费该 delivery 的 case 摘要、verifier 结果和 reference patches，直接生成该 delivery 的最终文件状态。并发上限由 `REPOSITORY_PATCH_SYNTHESIS_MAX_CONCURRENCY` 控制，默认 `4`。
