# 仓库审查策略

语言：[English](REPOSITORY_REVIEW_STRATEGY.md) | 中文

本文为 [REPOSITORY_REVIEW_STRATEGY.md](REPOSITORY_REVIEW_STRATEGY.md) 的中文译文；如有差异，以英文版为准。

## 适用范围

`repository-review` 是一条独立于 `issue-review` 和 `pull-request-review` 的仓库级工作流。它会扫描仓库，把文件级可疑点收束成少量高价值的问题簇，后文称为 `case`。值得处理的 `case` 会进入 `analyzer / cvss-v4-scoring / mitigator / verifier`，最终发布 scan 摘要和少量 draft PR。

这条工作流先追求初筛覆盖，再做去噪与问题收束，最终产出审查者可以审查的结果。它不要求单个 Agent 理解整个仓库，也不追求最大化发现数量。

## 阶段组成

工作流包含以下阶段：

1. `scan / case formation`：`discovery -> triage`
2. `per-case review`：对每个保留的 `case` 执行 `analyzer / cvss-v4-scoring / mitigator / verifier`
3. `delivery`：`delivery-planning -> delivery-execution`，随后由 GitHub Integration 发布摘要和 draft PR

其中 `cvss-v4-scoring` 与同 case 的修复和验证路径并行执行；delivery execution 会为 `combined` delivery 调用 patch-synthesis 子模块。

## 各阶段职责

### `discovery`

Discovery 采用局部 chunk 初筛，而不是让 Agent 在整个仓库里自由探索。

<!-- doc-default: AGENT_DISCOVERY_CHUNK_STRATEGY; source=agents/src/sec_review_agents/scan_stages/discovery/stage.py -->

Discovery 默认采用 `single-file`，每次模型调用扫描一个完整文件。部署侧可以通过 `AGENT_DISCOVERY_CHUNK_STRATEGY=batched` 将路径相近的文件按上下文预算组成 chunk，以共享局部上下文。具体文件选择和预算规则见 [DISCOVERY_AGENT_DESIGN](DISCOVERY_AGENT_DESIGN.zh.md)。

Discovery 产出结构化 `candidate`，包括位置、类别、理由和置信度。它不直接确认漏洞，也不做 `vulnerability_type` / `CWE` 分类，以保持高召回和轻量输入。

它负责初筛覆盖，不负责最终确认、跨文件根因合并或报告生成。

### `triage`

`triage` 位于 `discovery` 之后、`analyzer` 之前，负责把高召回的文件级 candidate 去噪并收束成少量高价值 case。

Triage 基于仓库可观察证据，决定哪些 candidate 应 keep、suppress 或 merge。merge 表示这些 candidate 描述的是同一个可观察安全问题，而不是宽泛的同类模式。

它不应仅因为同文件、同路由或同类漏洞而过度 merge，也不应仅因为行为被文档描述、带有 internal/debug/legacy 语义，或存在不完整防护检查，就过早 suppress。只有值得继续分析的 case 会进入 Analyzer。

### `analyzer`

常规 case 经 `triage` 保留后进入 `analyzer`；增量审查中，删除文件还会生成 case，直接进入分析，见[REPOSITORY_INCREMENTAL_REVIEW_STRATEGY](REPOSITORY_INCREMENTAL_REVIEW_STRATEGY.zh.md)。该阶段复用 narrative-first 思路，输出按 `priority` 排序的 narratives、位置、输入来源事实、敏感操作事实、证据缺口，以及漏洞类型/CWE 分类和供审查者阅读的摘要。

Analyzer 先核查 candidate 并给出有证据支持的结论，再进入修复和交付。分析结论不决定是否执行修复和验证阶段；没有合理修复依据时，后续阶段可以不修改代码。

`analyzer` 必须遵守 case 范围边界：

- 可以确认、缩窄或否定当前 case；
- 但不能把当前 case 改写成另一个独立问题并沿用原 `case_id` 继续推进；
- 邻近独立问题不得进入当前 case 的 `narratives`，也不进入当前 case 的修复和验证 / delivery execution。

### `cvss-v4-scoring`

`cvss-v4-scoring` 位于 `analyzer` 之后，负责基于 Analyzer facts 做 CVSS v4 base metric 判定，并输出标准化 `vector / base_score / severity`。分数用于报告层风险表达，不作为主要调度或修复优先级信号。

该阶段只在当前 case 范围内做定向事实核实和标准化打分，不重新判断 Analyzer 的漏洞结论，也不使用修复后的状态信息。

### `mitigator`

`mitigator` 根据分析结果和仓库证据判断是否有合理修复方案。需要修改时，补丁应靠近实际安全边界或危险操作，范围尽量小且便于审查。大范围探索、无关的重新分析和重构不属于这个阶段。

### `verifier`

`verifier` 负责独立复核 Analyzer 和 Mitigator 输出。它检查 Analyzer 是否过度表述，补丁是否真正修到点上，以及补丁是否引入明显副作用或绕过。

在仓库审查路径里，`verifier` 同时检查报告和补丁，并为 keep/blocked 决策提供最后一道质量门槛。

Verifier 从输入快照恢复独立工作区，并在开始调查前应用修复补丁。工作区提供打补丁后的代码，允许验证命令和测试写入文件。补丁无法应用时，验证失败，不会基于未打补丁的基线代码判断补丁覆盖。

### `delivery-planning`

只有 `disposition="keep"` 的 case 结果会进入 delivery planning / delivery execution。

`delivery-planning` 将可交付的 case 分组。判断主要依据各 case 已准备的输出，而不是某个共享工作区的最终状态。它优先使用 case item payload、修复概述、变更文件和 workbench state；这些信息不足以判断是否必须合并交付时，才读取各 case 的补丁。

merge 原则只看交付是否必须绑定同一 PR，而不是 case 在语义上是否相关。只有需要协调执行、共享补丁范围、存在发布依赖或分开发会产生执行冲突时才建 `combined` delivery；否则保持 `single`。delivery execution 消费该计划并产出 repository delivery result，集成应用只消费结果，不反推合并策略。

### `delivery-execution`

delivery execution 接收 `delivery-planning` 的计划，并产出 GitHub Integration 可以发布的产物。`single` delivery 会整理单个 case 已经产生的文件改动；`combined` delivery 会调用 patch-synthesis 子模块，生成一组协调后的最终文件状态。

实现顺序是固定的：

1. 基于 delivery-planning 约束确定 delivery 执行单元；
2. 对 `combined` delivery 调用 patch-synthesis 子模块；
3. 组装 delivery result，只写入实际可发布的 delivery 产物。

delivery execution 按 delivery 策略分两种路径：

- `single`：不调用 Agent，不进入 patch synthesis 并发窗口，也不重新应用或复制 case `workspace.patch`。它直接消费对应 case 的 `review_record.mitigation.file_changes`，投影为可发布 delivery 产物；若没有可发布 `file_changes`，该 delivery 不写入对外 `deliveries[]`。
- `combined`：调用 patch-synthesis Agent，在隔离的初始工作区中消费该 delivery 的 case 摘要、Verifier 结果和 reference 补丁，直接生成该 delivery 的最终文件状态。并发上限由 `REPOSITORY_PATCH_SYNTHESIS_MAX_CONCURRENCY` 控制，默认 `4`。
