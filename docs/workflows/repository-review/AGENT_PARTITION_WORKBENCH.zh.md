# Agent-Edited Partition Workbench

语言：[English](AGENT_PARTITION_WORKBENCH.md) | 中文

本文是 [AGENT_PARTITION_WORKBENCH.md](AGENT_PARTITION_WORKBENCH.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

## 背景

有些 repository workflow 阶段不是逐个判断对象，而是把一批 item 整理成更少的工作单元。

这类任务不适合让 agent 一次性输出一个巨大的最终结构，因为很难同时保证没有漏项、重复消费或非法归属。更自然的方式是让系统维护一个工作台，agent 只通过少量工具查看和编辑它，最终由系统导出结果。

## 问题定义

### 形式化定义

从抽象上看，这类阶段是在满足 coverage、non-overlap 和阶段规则的前提下，把一组 items 分配到若干 typed groups 中。

更严格地说：

> 给定一组输入 items，每个 item 有稳定 id 和阶段定义的 payload；目标是把这些 items 分配到若干 typed groups 中。每个 group 有 `kind`、`reason` 和 `item_ids`，也可以有阶段扩展 metadata。最终分配需要满足 coverage、non-overlap、合法 group kind、必填 metadata 和最终导出契约等结构约束；同时，每个 group 还应满足当前 workflow 的语义边界，例如同一 root issue、同一 patch boundary、同一 trust failure 或仍有独立分析价值。

其中，`non-overlap` 是 at-most-once：一个 item 同一时刻最多属于一个 group。`coverage` 是 at-least-once：结束时每个 item 都必须属于某个 group。两者合起来就是最终状态的 exact-once assignment。

### 约束类型

这里的约束需要分清两层：

- 结构约束：item id 合法、non-overlap、coverage、合法 group kind、必填 metadata、最终导出契约等。
- 语义边界：是否同一个 root issue、是否同一个 patch boundary、是否同一个 trust failure、是否应该 suppress、是否仍有独立分析价值等。

结构约束通常可以由系统可靠维护和检查；语义边界需要语义判断，不能只靠静态规则证明。

### 不满足闭包

group membership 通常满足交换性：如果 A 和 B 属于同一个 group，成员顺序不改变 group 含义。但语义关系不一定满足传递性：A 和 B 共享边界、B 和 C 共享边界，不代表 A 和 C 也应该同组。B 可能只是 bridge item。不能把 pairwise relatedness 当成连通图做 transitive closure；每个 group 都应该有一个所有成员共同落入的 primary boundary。

Partition workbench 是这个问题的一种 agent-edited 实现，后面再说明系统状态、工具和完成信号如何落地。

### 有关但不同的问题

它和几类常见问题相似，但不等同：

- 不是普通 clustering：目标不是按自然相似度发现簇，而是形成阶段定义的工作单元。
- 不是普通 classification：group 不是预定义 label，而是动态创建、带 `kind`、`reason` 和 membership 的资源。
- 不只是 deduplication：`keep` / `suppress` 等 group kind 表达的是阶段语义，不只是“重复/不重复”。

### 相关工作定位

底层数学形态最接近 constrained partitioning：系统要把 items 分到 groups，同时满足 coverage、non-overlap、合法 group kind 和阶段规则。Google OR-Tools 的 [assignment with allowed groups](https://developers.google.com/optimization/assignment/assignment_groups) 展示了“在 group 约束下做 assignment”的形式化方向。不过这类优化建模通常要求约束可枚举、目标函数明确；这里“是否同一 root issue / patch boundary / trust failure”仍然需要 agent 做语义判断。

如果把 agent 的判断改成 must-link / cannot-link 关系（成对约束：两个 items 必须同组 / 不能同组），再由系统自动聚合 groups，那么它会更接近 constrained clustering。constrained clustering 文献通常围绕 must-link / cannot-link 背景知识寻找满足约束的 partition，[综述](https://link.springer.com/article/10.1007/s10462-024-11103-8) 也讨论了 hard constraints、soft constraints、噪声约束和不同约束类型。这个方向说明 pairwise constraints 是成熟工具箱，但也带来 pair 数量爆炸、噪声、冲突和约束选择问题；因此它更适合作为内部 hint，而不是当前主流程。

correlation clustering 是另一个相邻方向：它把对象之间的 positive / negative pairwise 关系作为输入，寻找尽量满足这些关系的 partition。相关工作也指出 constrained correlation clustering 这类问题通常有较高计算复杂度，例如 [weighted partial MaxSAT 形式](https://www.sciencedirect.com/science/article/pii/S0004370215001022) 把它作为约束求解问题处理。这个方向能解释为什么“全量 pairwise 化”不是免费的工程简化。

LLM-guided clustering 说明 LLM 可以参与产生语义约束。例如 [Large Language Models Enable Few-Shot Clustering](https://aclanthology.org/2024.tacl-1.18.pdf) 使用 LLM 作为 pairwise constraint 的来源，再做 clustering。它和这里的共同点是让 LLM 参与语义分组判断；差异是当前设计不是“LLM 生成约束再聚类”，而是“agent 直接编辑 typed workbench”，并且 groups 还带 `kind`、`reason`、summary / evidence 等阶段 metadata。

工业类比上，它更像 alert grouping / alert correlation：把大量细粒度信号组织成更少、更可处理的工作单元，减少噪音并匹配 triage / response 流程。Jira Service Management 的 [alert grouping](https://support.atlassian.com/jira-service-management-cloud/docs/configure-alert-grouping/)、PagerDuty 的 [Alert Grouping](https://support.pagerduty.com/main/docs/alert-grouping) 和 ServiceNow 的 [alert correlation rules](https://www.servicenow.com/docs/r/zurich/it-operations-management/event-management/t_EMConfigureAnEventCorrelationRule.html) 都体现了这个工业需求：不是为了发现自然簇，而是为了把相关信号组织成可处理的工作单元。

## 为什么这样做

这类 partition 任务有大量语义判断，通常很难完全写成静态规则或优化目标。例如两个 items 是否应该同组，可能取决于 shared root issue、patch boundary、trust failure、review unit、弱旁证是否有独立价值等上下文判断。这些判断适合交给 agent 做。

最直接的 agent 方案，是让 agent 一次性输出完整的 item -> group 映射或最终 JSON。但这种做法会把太多机械责任也交给 agent：

- 记住所有 item。
- 保证阶段要求的 coverage。
- 维护 group 之间不重叠。
- 在输出巨大结构时不漏字段、不漏 id。
- 在发现局部错误后重写整份结果。
- 在完成后额外生成不受 contract 约束的自然语言总结。

Partition workbench 的取舍是：让 agent 继续负责语义判断，但把机械责任交还给系统。agent 只负责创建、移动、合并、拆分和解释 groups；系统负责状态一致性、结构约束检查和最终导出。

这种模式更接近人类处理复杂集合任务的方式：不是一次性写出最终表格，而是在一个可见工作台上持续整理、移动、修正，直到状态通过检查。

## 工作台模型

系统维护两类核心状态：

- `items`: 输入项，只读。每个 item 有稳定 id 和阶段定义的 payload。
- `groups`: agent 创建和编辑的工作单元。

item 到 group 的归属关系由系统从 `groups[*].item_ids` 派生维护。

Partition workbench 的底层操作和 payload 语义无关。payload 是阶段提供给 agent 的只读判断材料；工作台只按 item id 和 group membership 维护状态、检查结构约束，并在结束时导出阶段结果。

编辑过程中，系统维护 non-overlap：

- 一个 item 同一时刻最多属于一个 group。
- item 被放入新 group 时，系统会同步更新它的单一归属。
- group 被删除时，其中的 items 变为未覆盖状态。

结束时，系统检查最终约束：

- 每个 item 都必须被某个 group 覆盖。
- groups 必须满足当前 workflow 的 schema 和完成条件，例如合法 `kind`、必填 metadata 和允许的最终归属形态。

对 delivery planning 来说，所有 item 最终都必须进入同一种 `delivery` group；对 triage 来说，item 可以进入 `keep` group，也可以进入 `suppress` group，具体规则由阶段定义。

## 工具形状

工具的语义保持小而通用，核心是对 group 资源做 CRUD。

原子写入工具：

- `create_group`: 创建一个 group，可同时给出初始 `item_ids`。
- `update_group`: 更新一个 group 的 metadata 或 `item_ids`。
- `delete_group`: 删除一个 group，被删除 group 中的 items 变为未覆盖状态。

批量写入工具：

- `create_groups`
- `update_groups`
- `delete_groups`

1. 批量工具不是全新的分组方法，只是原子 group CRUD 的同构批量形状。它们和 `create_group` / `update_group` / `delete_group` 受同一套 membership 和 constraints 规则约束，用来降低 tool call 数和中间状态噪声。
2. 批量工具不应被理解成最终提交工具。如果 agent 已经能从输入 payload 直接形成完整草稿，优先用 `create_groups` 一次创建完整草稿是合理的；之后再用原子工具或批量工具修正少量错误即可。若需要完整重写已有草稿，应先 `delete_groups` 清空相关 groups，再 `create_groups` 创建新草稿。

批量写入工具应尽量先检查命令级结构冲突，再开始修改工作台。尤其是 `create_groups` 这类会新增资源的工具，应在写入前检查 batch 内和现有 state 的 `group_id` 冲突；如果批量调用失败，不应留下部分创建的 group 或部分记录的 edit event。

读取工具：

- `read_groups`: 读取当前 group 列表，包含 group metadata 和 item_ids membership。

检查工具：

- `check_constraints`: 读取当前工作台硬约束检查结果，例如 coverage 或必填 metadata 缺失等等。

不暴露的工具（经验之谈），主要目的都是减少不必要的 agent tool call：

- 不暴露 `read_group`: agent 应通过 `read_groups` 判断当前 draft 结构；按单个 group 再展开 item payload 容易重复 prompt 中已有证据，并诱导反复读取。
- 不暴露 `read_item` / `read_items`: item payload 通常作为 user prompt 输入直接提供。工作台底层只按 item id 和 group membership 操作，不需要 agent 逐项读取 item payload。

### 写入工具返回值

`create_group` / `create_groups` / `update_group` / `update_groups` / `delete_group` / `delete_groups` 是写入工具，不应该顺手返回完整 group 列表。

写入工具的返回值应该是 compact mutation result，只说明本次写入发生了什么，以及当前硬约束是否仍然满足。完整 group 列表只能通过 `read_groups` 显式读取。

避免写入工具每次返回完整 groups 很重要。否则一次小编辑会把全量 group metadata 反复塞回上下文，造成 token 放大，也容易让 agent 在巨大 tool output 中误读状态。

### 完成信号

agent 不通过普通工具导出最终结果，而是返回一个极薄的 structured completion response，例如 `{"done": true}`。

系统在完成信号处运行 structural constraints checker。只有 coverage、non-overlap、合法 `kind`、必填 metadata 和最终导出契约等结构约束通过时，完成信号才有效；之后系统从工作台状态导出最终结果。

如果结构约束没有通过，系统会拒绝完成信号，agent 应继续调整工作台，而不是结束。语义边界是否正确仍是 agent 的判断结果，不由 constraints checker 自动证明。

## Agent 工作方式

agent 不直接输出最终 plan。它应该像人在工作台前整理卡片一样工作：

1. 首先看到了输入中的静态背景信息（通常是全部 item 的 payload）。
2. 查看未处理 item，当前工作台状态，并结合输入中的静态背景信号。
3. 创建 group(s)，并放入初始 item(s)。
4. 通过更新 group 调整元数据或 item 归属，或者删除不再需要的 group。
5. 查看当前状态和 constraints。
6. constraints 通过后返回 completion response 结束。

最终结果由系统从工作台状态导出，而不是由 agent 手写完整 JSON 或自然语言总结。

这个工作方式应该是可重入的：agent 可能面对一个空工作台，也可能面对上一轮已经整理过的 groups。它每次都先读取当前状态；如果已有 groups，大多时候把它们当作草稿做局部修正，而不是从头重建。

### Refinement

可重入性让第二轮 refinement 变得自然：第一次 agent run 可以从空工作台创建完整草稿；第二次 agent run 可以继承同一个工作台，把已有 groups 当作 draft 做质量修正。

引入 refinement 的原因不是 coverage。coverage 是系统 constraints checker 的任务。真实问题是 agent 在第一次 pass 里常常读完整输入后直接用 `create_groups` 一次性创建草稿，然后很自信地结束。这种草稿通常满足 constraints，但仍可能有 over-merge、missed merge、weak reason 或 keep/suppress 边界错误。

一个自然想法是让同一轮 agent 在结束前自检。但“自检”很容易被模型执行成 bookkeeping：重新数 items、复述 groups、为已有分组写长篇理由，或证明 coverage 完整。它会增加 token 和上下文噪声，却不稳定地产生更好的 edits。Refinement 的价值在于先把第一轮判断外化成 workbench state，再让下一轮把它当作 draft，只寻找具体可编辑的 group 边界问题；没有具体 edit 就结束。

有效的 refinement 应该：

- 先用 `read_groups` 读取当前 draft 结构；
- 用 prompt 中的 item payload 审查有风险的 group 边界；
- 重点检查 over-merge、missed merge 和 weak reason；
- 通过 `update_group(s)` / `create_group(s)` / `delete_group(s)` 做 targeted group edits；
- 最后读 constraints 并结束。

不应鼓励 agent 在 constraints ok 后手动数 item_ids、列出每个 group 或重述 coverage。这些 bookkeeping 会污染后续上下文，而且系统已经能可靠检查。

### Single 与 Batch

在这个工作台模型上，常见执行模式有两种：

- `single + optional refinement`: 一个 agent pass 处理完整 item inventory；如果需要质量修正，再用同一个工作台跑 refinement。
- `batch + refinement`: 多个 batch draft 并行处理 item 子集，再把草稿合并到一个全局工作台做 refinement。

batch 是 wall-time 压力下的折中，不是默认更聪明的规划方式。

它最初被引入，不是因为中等规模输入必然放不进上下文，而是因为**较慢模型一次处理较多 items 时 wall time 太长**。batch 可以把 draft 阶段拆开并行，降低每个 draft invoke 的输入规模和等待时间。

batch 的好处是快，**尤其在慢模型上明显**。但它有实际代价：

- batch draft 看不到跨 batch 的合并机会，也就是所谓的缺少全局视野；
- global refinement 仍然需要全局审计。

因此，batch 更适合作为 latency workaround，而不是默认形态。尤其当较快模型的 single run 已经足够快时，batch 的 wall-time 优势会变小，坏处反而更明显：它会引入 batch 边界损失，并且仍然刚需一轮 global refinement 来恢复全局判断。

也不要过早把这个 batch 设计描述成“解决超大输入”的方案。如果 refinement 仍然需要读全量 item payload，那么 batch 只是降低了单次 draft invoke 的输入规模和推理耗时，并没有消除最终全局审计面对全量 items 的问题。

### Batch Refinement Context

当一个阶段用 batch draft 再接 global refinement 时，系统可以在 refinement 的 user prompt 里提供轻量的 draft origin 列表，帮助 agent 优先检查跨局部上下文的边界问题。

推荐形状是按 origin scope 列出 group id：

```markdown
Use this section only to prioritize refinement attention. Groups from different draft scopes may not have been compared in the same pass.

- `draft batch 0001`: `group-1`, `group-2`, `group-3`
- `draft batch 0002`: `group-4`, `group-5`
```

这不是 group metadata，也不是新的工具视图。group 本体仍然只表达当前工作台状态；draft origins 只是 refinement pass 的只读上下文，用来说明哪些 groups 是在同一个局部 draft scope 中产生的。

这样做的目的不是让 agent 信任 batch 内结果，而是调整注意力优先级：

- 优先检查不同 draft scope 之间的重复、漏合并、边界错位或 keep/suppress 不一致。
- 同一 draft scope 内的 groups 已经在同一个局部上下文中被共同看过，除非边界明显弱，不需要平均投入同等审查成本。
- 如果 refinement 后 group 被移动、合并或删除，draft origins 不需要作为最终状态同步；最终结果仍由当前 groups 导出。

这个设计应保持轻量。不要把 item payload、summary、evidence 或 reason 复制进 draft origins；这些信息已经可以通过 `read_groups` 和阶段输入获得。Draft origins 只回答一个问题：哪些 groups 来自同一个局部 draft context。

## 常见分组意图如何落到工具

这些分组意图不需要作为独立工具暴露给 agent。下面只用简短情景说明它们如何落到基础工具上。

普通分组和调整：

| 情景 | 做法 | Tool 调用 |
| --- | --- | --- |
| 一个 item 应该单独留下 | 创建一个正常 group，并把这个 item 作为初始成员。 | create_group(item_ids=[item_id]) |
| 多个 item 应该一起处理 | 创建一个正常 group，并把这些 item 作为初始成员。 | create_group(item_ids=[...]) |
| 两个已有 group 后来发现其实是一组 | 更新目标 group 的 item_ids，让它包含两边的 item，再删除空出来的 group。 | update_group(item_ids=[...]) -> delete_group |
| 一个 group 里混进了不该在一起的 item | 创建新 group 接走一部分 item，再更新原 group 的 item_ids。 | create_group(item_ids=[...]) -> update_group(item_ids=[...]) |
| 一个 group 的成员应该整体重写 | 用新的 item_ids 更新这个 group。 | update_group(item_ids=[...]) |
| 一个 item 放错了 group | 更新正确 group 的 item_ids，把这个 item 放进去；系统会自动移除旧归属。 | update_group(item_ids=[...]) |
| 一个 item 暂时不应属于任何 group | 更新当前 group 的 item_ids，把这个 item 移出。 | update_group(item_ids=[...]) |
| group 的解释不准确 | 更新 group 的 reason。 | update_group(reason=...) |

允许舍弃 item 的阶段才需要 `suppress` group：

| 情景 | 做法 | Tool 调用 |
| --- | --- | --- |
| 一个 item 应该被压掉 | 创建 `suppress` group，并把这个 item 作为初始成员。 | create_group(kind=suppress, item_ids=[item_id]) |
| 多个 item 因同一原因被压掉 | 创建 `suppress` group，把这些 item 作为初始成员，并写清 reason。 | create_group(kind=suppress, item_ids=[...]) |
| 一个被压掉的 item 又应该恢复 | 更新正常 group 的 item_ids 接走它，或删除 `suppress` group 让它回到未处理状态。 | update_group(item_ids=[...]) 或 delete_group |

从 prompt 的角度，可以继续使用这些分组意图帮助 agent 理解任务；从工具的角度，仍然保留 group 读取、constraints 检查、单个 group CRUD 和批量 group CRUD。结束由 structured completion response 表达。

## 附录

### Delivery Planning 实验记录

下面记录的是 bookshop repository delivery planning 在一次 53-item 输入上的对比实验。实验目的不是给模型永久排名，而是帮助理解 single / batch、flash / pro 在当前 workflow 设计下的取舍。

实验设置：

- `single-flash`: single draft + refinement，使用 flash 模型。
- `single-pro`: single draft + refinement，使用 pro 模型。
- `batch-flash`: 两个 batch draft 并行 + global refinement，使用 flash 模型。
- `batch-pro`: 两个 batch draft 并行 + global refinement，使用 pro 模型。

| Experiment | Passes | Wall time | Total tokens | AI messages | Deliveries | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `batch-flash` | 3 | ~2m58s | 285k | 13 | 27 | 最快；成本可控；有少量 batch 边界导致的过合并。 |
| `batch-pro` | 3 | ~9m00s | 268k | 12 | 26 | token 不再爆炸，但质量较差，留下多个 bridge / transitive merge。 |
| `single-flash` | 2 | ~3m59s | 449k | 12 | 28 | 质量较好；refinement 读了两个 patch，导致 token 偏高。 |
| `single-pro` | 2 | ~15m06s | 272k | 9 | 29 | 质量最好、最保守，但 wall time 最高。 |

说明：

- batch 的 wall time 按端到端计算：两个 draft 并行，取较慢的 draft 时间，再加 global refinement。
- `single-flash` 的 token 偏高主要来自 refinement 中的 patch inspection。
- `batch-pro` 的问题不是 token，而是质量：它更容易通过 bridge case 做 transitive merge。

主要质量观察：

- `single-pro` 是这轮质量上界；`single-flash` 接近它，但更快。
- `batch-flash` 是最有希望的 batch 形态：快、便宜，但需要 refinement 更好地修正 batch 边界损失。
- `batch-pro` 不适合作为默认；它修正了一个较小的 cookie 过合并，但留下了更严重的 checkout / JWT / addReview bridge 合并。
- Delivery count 不能单独作为质量指标。数量少可能是有效合并，也可能是 harmful over-merge。

从这轮实验得到的短期策略：

- 以 `single` 作为质量基线。
- 当较快模型的 single run 已经足够快时，不默认启用 batch。
- 只有 single 的 wall time 或单次处理负担不可接受时，再把 batch 作为 latency workaround。
- `batch draft + full global refinement` 不能声称解决了超大输入问题，因为 refinement 仍然需要全局 evidence。

### Triage 实验记录

下面记录的是 bookshop repository triage 在一次 95-candidate 输入上的阶段性对比实验。它发生在后续几轮 prompt 继续收紧之前，因此更适合作为 workflow 观察，而不是最终质量结论。

实验设置：

- `single-flash`: single draft + refinement，使用 flash 模型。
- `single-pro`: single draft，使用 pro 模型。
- `batch-flash`: 多个 batch draft 并行 + global refinement，使用 flash 模型。
- `batch-pro`: 多个 batch draft 并行 + global refinement，使用 pro 模型。

| Experiment | Passes | Wall time | Total tokens | AI messages | Keep cases | Suppressed | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `batch-flash` | 5 | ~2m36s | 434k | 20 | 62 | 27 | 最快；成本可控，但 refinement 仍有成本。 |
| `batch-pro` | 5 | ~12m03s | 476k | 22 | 45 | 25 | 比 flash 更慢，输出更保守，仍需要检查跨 batch 边界。 |
| `single-flash` | 2 | ~3m40s | 492k | 11 | 73 | 22 | 速度可接受，但偏向保留更多独立 case。 |
| `single-pro` | 1 | ~12m08s | 333k | 7 | 33 | 42 | 最激进，压掉和合并更多 candidate；需要人工确认是否过度。 |

说明：

- batch 的 wall time 按端到端计算：batch draft 并行，之后再加 global refinement。
- triage 的 case 数量比 delivery planning 更难直接解释：数量少可能是正确去重 / suppress，也可能是 over-suppress 或 over-merge；数量多可能是保守，也可能是漏合并。
- batch 的主要目的仍是降低单轮输入规模和 wall time。它在 triage 里的一个副作用是减少 single pass 一次看见大量 candidate 时按宽泛主题过度合并的机会；代价是更容易产生跨 batch 漏合并或误分裂，所以 global refinement 必不可少。

主要质量观察：

- `single-flash` 倾向保留更多 case，适合作为保守基线，但可能把弱 companion、schema/client-only 或泛化 hardening 保留下来。
- `single-pro` 倾向更强压缩，能减少噪声，但更需要警惕 over-suppress 和跨边界合并。
- `batch-flash` 在速度和质量之间比较均衡；它提示 triage 的 batch 不只是 latency workaround，也会改变模型面对大输入时的分组倾向。
- `batch-pro` 没有明显成为质量上界；更强模型不一定更适合这个 grouping 任务。

从这轮实验得到的短期策略：

- triage 需要把“同一 root issue / 直接调用链 / 同一 sink 或 trust failure”讲清楚，同时避免陌生概念和过度枚举规则。
- 对 triage 来说，batch 可以用于降低单轮输入压力；它减少宽泛主题过度合并只是副作用，不能替代 refinement。
- 不应只用 keep case 数量判断质量；需要看 suppressed 是否合理、同一 root issue 是否合并、独立 sink 是否被错误合并。
- 在当前形态下，`single-flash` 和 `batch-flash` 都值得保留实验入口；`pro` 更适合做对照，不宜直接假设为默认更好。
