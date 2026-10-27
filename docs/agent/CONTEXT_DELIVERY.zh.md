# 上下文投递

语言：[English](CONTEXT_DELIVERY.md) | 中文

本文是 [CONTEXT_DELIVERY.md](CONTEXT_DELIVERY.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

本项目中的 agent 通过两种方式获得上下文：一部分内容已经渲染进 prompt，另一部分留在 workspace 里，由 agent 用自己的工具去取。按 agent 在这两者之间做选择是设计决策，不是偏好，选错时代价也不同。

## 两种策略

**预加载。** 内容放进 user prompt。模型在第一轮就读到它，没有工具调用，没有额外往返，也不会取错东西。代价是无条件的：无论本次任务是否需要，每次请求都带着它；底层数据一变，这份 prompt 就过时。

**按需读取。** 内容留在已挂载的路径上，agent 用 `read_file`、`grep`、`ls` 或 `execute` 去取。模型付出一次工具轮次和一点延迟，换来的是自己选择读什么，并且只读问题需要的那部分。代价只在任务真正需要时才付出。

## 何时各自更优

决定性的问题不是内容有多大，而是内容是否**稳定且每次都需要**：

- **预加载**只在内容**既必需、又完整**时才成立。必需，指这个 agent 的每次运行都必须拿到它才能作答；完整，指预加载的部分就是全部输入，而不是一份还需要 agent 自己去补全的样本。case 摘要、候选列表、discovery 分块中内联的文件都属于这一类。预加载一份之后还要 agent 去补全的内容，是两头不讨好：多了一次工具轮次，还背着一份可能已经过时的 payload。
- **按需读取**适用于内容大、每次都在变、或只有部分相关的情况。仓库、diff、模型可能查也可能不查的产物属于这一类。

第二个判断依据是：agent 是否本来就会自己去取。如果它无论如何都会检查仓库，那么预加载一份渲染副本等于让模型看到同一份信息两次，而且 prompt 里那份还会过时。本项目的实测：pull request 审查的 prompt 带着预渲染的变更文件清单时，四次被观测的阶段运行里有三次仍然自己跑了 `git diff --name-only` 或 `git diff --stat`；移除该清单后，analyzer 的 prompt 从约 5,900 字符降到约 550 字符，调查行为没有损失。

两种策略都不是压倒性胜利。最接近的对比是 [Skill Blocks: How Should an Agent Load Its Skill?](https://arxiv.org/html/2608.14943v1)（arXiv 2608.14943），它在五个基准上比较了整份预加载与按需加载部分内容：

> There is no universal winner. On SearchQA, hybrid reduces input by 27.4%, while heavily encouraged Skill Block loading increases it by 48.4%.

按需加载在另外两个数据集上把有效输入降低了 52.8% 与 73.0%，同一篇论文也指出更长的输出可能吃掉小幅的输入节省。[Just-in-time retrieval](https://learn.agentpatterns.ai/context-engineering/just-in-time-retrieval/) 从上下文工程的角度给出同样的规则：上下文里保留一个小而稳定的核心，其余内容等到任务真正走到那里再加载。

预加载同样有支持它的证据，而且并不只是“成本更低的那个选项”。

**位置比是否出现更关键。** [Lost in the Middle](https://arxiv.org/abs/2307.03172)（TACL 2023）测量了模型对其所获信息的实际利用率：

> performance is often highest when relevant information occurs at the beginning or end of the input context, and significantly degrades when models must access relevant information in the middle of long contexts, even for explicitly long-context models

按需读取并不能绕开这个问题。工具结果落在不断增长的对话中段，要同后面每一轮竞争注意力；而预加载的内容处在一个固定位置，模型一开始就读到。按需读取换来的是选择性，而不是被读到的保证。

**选择性读取要求 agent 选得准。** 一份对 900 条 agent 轨迹的定性分析在三个模型家族上都发现了四类反复出现的失败模式（[arXiv 2512.07497](https://ar5iv.labs.arxiv.org/html/2512.07497)）：

> (1) premature action without grounding, such as guessing schemas instead of inspecting them; (2) over-helpfulness under uncertainty, where models substitute missing entities with plausible alternatives; (3) vulnerability to context pollution, in which distractor data induces incorrect reasoning; and (4) fragile execution under cognitive load, including malformed tool calls, generation loops, and inconsistent recovery from errors.

其中两类正是按需读取额外引入的成本。当 agent 自己决定取什么时，它可能按假设的结构行动而不是真实结构，也可能用看起来合理的东西填补空缺而不是回到源头。预加载把这些决策取消了：无论 agent 会不会正确地索取，内容都在那里。这正是“小而必需的输入”值得预加载的理由，也是 discovery 分块以内联完整形式送达、而不是挂载一个路径的原因。

## 本项目各 agent 的选择

| agent | 策略 | 预加载了什么，或为什么不预加载 |
| --- | --- | --- |
| 仓库 discovery | 预加载 | 被扫描的文件以内联形式随 prompt 到达。discovery 不挂载任何 workspace，因此无法自行读取：输入必须完整，prompt 也明确说明这些内联内容就是全部输入。 |
| 仓库 triage | 预加载 | 候选 payload 随 prompt 到达。triage 按设计不挂载 workspace，其判断被定义为“仅凭 payload 作出”。 |
| pull request 的 analyzer、mitigator、verifier | 按需读取 | 挂载 workspace 与 `/history`，agent 通过 git 读取窗口。prompt 携带 PR 文本、引用信息与上一阶段结果，但不含渲染好的文件清单或 diff。 |
| issue 的 analyzer、mitigator、verifier | 按需读取 | 挂载 workspace 与 `/history`；issue 文本被预加载，因为它是本次审查的信号本身。 |
| 仓库 case 的 analyzer、mitigator、verifier | 按需读取 | 挂载 workspace、`/history` 与 `/incremental-window`，case 审查输入只给出锚点，不摘抄文件。 |
| CVSS | 混合 | 评分需要看一次代码，因此挂载 workspace，并预加载待评分的发现。 |
| 删除 case | 预加载，仅路径 | case 携带文件路径与窗口，从不携带文件内容。当前没有文件可读，所以路径就是完整输入；内容来自 patch 或 git。 |

## 应用

**措辞的分量与选择本身相当。** 选定按需读取，并不等于结果已经定下：prompt 推动某种策略的力度会改变结果。在上面那组对比里，同一套按需机制，作为可选项提供时让 SearchQA 的输入降低了 27.4%，而 prompt 大力鼓励使用它时反而增加了 48.4%。提供一条路径，让任务自己决定要不要走；不要指示 agent 去取它没有理由想要的东西。

给 agent 增补上下文时，依次自问：

1. 这个内容是否每次运行这个 agent 都必需？不是就留在磁盘上。
2. agent 是否无论如何都会用自己的工具检查同一片区域？如果是，预加载一份渲染副本就是重复劳动，并且可能过时。
3. agent 是否具备读取它的挂载？如果 backend 没有暴露任何路径，预加载是唯一选项，此时 prompt 应当说明内联输入就是全部。

预加载时，只放决策真正需要的内容。把一份 agent 自己就能查询的文件清单渲染进 prompt，正是本项目移除掉的情形，不是应当效仿的模板。
