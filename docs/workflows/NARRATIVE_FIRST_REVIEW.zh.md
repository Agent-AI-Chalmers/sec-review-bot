# Narrative-First Review

语言：[English](NARRATIVE_FIRST_REVIEW.md) | 中文

本文为 [NARRATIVE_FIRST_REVIEW.md](NARRATIVE_FIRST_REVIEW.md) 的中文译文；如有差异，以英文版为准。

Analyzer 围绕 narrative 组织结果。每条 narrative 包含针对某个问题的解释、支持它的证据和判断结论，也可以记录证据不足，或未发现需要处理的问题的情况。这样可以避免 Agent 在读代码时堆积零散观察，最后只留下模糊印象。

系统要求 Agent 将分析收敛为一组可比较的解释，即 narrative（叙事），并明确优先级。输出包括：

- 分别记录的 narrative，每条有整数 `priority`，`1` 最高；
- 必要时保留少量相互竞争的解释，并用 `priority` 表明先后；
- 总体结论和面向审查者的 `overview` 摘要。

这套模型有几个约束：

- 如果返回 narrative，每条都必须带唯一的 `priority`
- `confirmed-vulnerability` 和 `confirmed-defect` 要和总体结论保持一致
- 当某条 narrative 的 `verdict=confirmed-vulnerability` 时，必须落到具体位置、`flow_review.source_facts`、`flow_review.sink_facts`，而不是只给抽象判断
- 结论为 `no-actionable-finding`（未发现需要处理的问题）的 narrative 应该说明被审查的方向、用来排除需要处理的问题的仓库证据，以及仍然重要的证据缺口
- `support_review.proof_gaps` 用来记录某个 narrative 还缺什么证据

系统一开始问的是“哪些审查方向值得保留下来，以及每个方向的证据支持什么结论”，不先问“有没有检查清单上的漏洞类型”。漏洞类型、CWE 和结论都从 narrative 推出；系统不会先定标签再去拼证据。

Narrative 也是 Analyzer、Mitigator、Verifier 三个阶段共享的工作对象。Mitigator 判断“是否值得修、修哪一处、最小修复边界应该落在哪里”时，优先看高优先级且结论为 `confirmed-vulnerability` 或 `confirmed-defect` 的 narrative，不在整份报告上平均用力。Verifier 默认不重新自由分析一轮，而是结合 Analyzer 报告（含 narrative、优先级与结论）和修复结果做独立复核。

## 一个包含两条 narrative 的实际例子

在一次改造审查结果如何发布到 GitHub 的 PR 审查中，最终结论是 `no-actionable-finding`，但 Analyzer 保留了两条 narrative。这个 PR 使用 PostgreSQL 记录发布进度，以便在进程退出、超时接管或重试后继续工作。两条 narrative 是支持同一个总体结论的两个独立审查方向，并非两个漏洞，也不是对同一问题的竞争解释：

| Priority | 审查方向                 | 主要问题                                                                                   | 代表性边界                                                        |
| -------- | ------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 1        | 输入进入危险操作（sink） | 不可信输入或仓库内容能否造成 SQL 注入、路径越界、branch injection 或打断 Markdown 代码块？ | 参数化 SQL、分支名片段规范化、敏感路径策略、Markdown 代码块分隔符 |
| 2        | 并发与远端副作用         | 超时、接管和重试期间，已失去任务资格的 Worker 能提交什么状态，远端 GitHub 操作如何恢复？   | 任务领取凭据、心跳续租、发布步骤、发布标记和稳定 branch identity  |

两条 narrative 的关系可以表示为：

```text
overall verdict: no-actionable-finding
  ├─ narrative 1: 输入到 sink 的控制没有暴露已确认攻击路径
  └─ narrative 2: 本地状态写入受到 fencing，远端重试具有可恢复身份
```

分开记录是因为它们依赖不同的证据，也可能独立改变结论。参数化 SQL 不能证明并发发布安全；任务领取凭据也不能证明文件路径安全。把它们塞进一条 narrative，会让输入来源、敏感操作、防护措施和证据缺口混在一起。

> 即使多条 narrative 的结论都是 `no-actionable-finding`，每条仍需准确描述控制边界。数据库 fencing 能阻止过期持有者提交本地状态，但不能撤销已经发出的 GitHub 请求。心跳续租、发布标记核对和稳定远端身份可以降低并协调重复副作用风险，却不等于远端原子 exactly-once。因而第二条 narrative 的合适命题是“本地提交受到 fencing，远端重试依赖可恢复身份”，而不是“完全防止重复 GitHub 副作用”。
