# Narrative-First Review

语言：[English](NARRATIVE_FIRST_REVIEW.md) | 中文

本文是 [NARRATIVE_FIRST_REVIEW.md](NARRATIVE_FIRST_REVIEW.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

analyzer 的输出不是“随手列几个发现”，而是围绕 narrative 来组织。这里的 narrative 不是空泛猜测，而是一个带有独立证据和 verdict 的可审查分析方向。它可以解释 confirmed issue、plausible risk、inconclusive path，也可以表示某个方向已经审过且结论是 no-actionable-finding。

这样做的目的，是避免 agent 一边读代码一边不断堆零散 observation，最后只留下一个模糊印象。相反，系统希望 agent 先收敛出一组可比较的解释，并给出清晰优先级。也就是说，输出的基本形状是：

- 一组 narratives（每条有整数 `priority`，`1` 最高）
- 必要时再保留少量在实质上相互竞争的替代解释，并通过 `priority` 体现先后
- 最后再给 overall verdict，并用 `overview` 承载 reviewer-facing summary

这套模型有几个约束：

- 如果返回 narratives，每条都必须带唯一的 `priority`
- `confirmed-vulnerability` 和 `confirmed-defect` 要和 overall verdict 保持一致
- 当某条 narrative 的 `verdict=confirmed-vulnerability` 时，必须落到具体 location、`flow_review.source_facts`、`flow_review.sink_facts`，而不是只给抽象判断
- no-actionable narrative 应该说明被审查的方向、用来排除 actionable concern 的仓库证据，以及仍然重要的 proof gaps
- `support_review.proof_gaps` 用来记录某个 narrative 还缺什么证据

对读者来说，最重要的区别是：这个系统不是先问“有没有 checklist 上的漏洞类型”，而是先问“哪些审查方向值得保留下来，以及每个方向的证据支持什么 verdict”。漏洞类型、CWE 和 verdict 都是围绕这个 narrative-first 结构往外展开的，而不是反过来先定一个标签，再去拼证据。

这套结构不只服务 analyzer，也会被后续阶段继续消费。mitigator 不会对一整份报告平均用力，而是优先围绕高优先级、且 verdict 为 `confirmed-vulnerability` 或 `confirmed-defect` 的 narratives 判断“是否值得修、修哪一处、最小修复边界应该落在哪里”；verifier 也不是重新自由发挥一轮分析，而是会结合 analyzer 报告（含 narratives、priority 与 verdict）和 mitigation 结果做独立复核。换句话说，narrative-first 不只是输出格式，也是 analyzer、mitigator、verifier 三个阶段之间共享的工作对象。

## 一个包含两条 narrative 的实际例子

在一次改造审查结果如何发布到 GitHub 的 PR 审查中，最终结论是 `no-actionable-finding`，但 analyzer 保留了两条 narrative。这个 PR 使用 PostgreSQL 记录发布进度，以便在进程退出、超时接管或重试后继续工作。两条 narrative 不是两个漏洞，也不是对同一问题的两种竞争解释，而是支持同一个 overall verdict 的两个独立审查方向：

| Priority | 审查方向 | 主要问题 | 代表性边界 |
| --- | --- | --- | --- |
| 1 | 输入进入危险 sink | Runner 或 repository 影响的数据能否造成 SQL injection、路径越界、branch injection 或 Markdown breakout？ | 参数化 SQL、branch segment 规范化、敏感路径策略、Markdown code fence |
| 2 | 并发与远端副作用 | 超时、接管和重试期间，stale worker 能提交什么状态，远端 GitHub 操作如何恢复？ | claim token、heartbeat、publication step、marker 和稳定 branch identity |

两条 narrative 的关系可以表示为：

```text
overall verdict: no-actionable-finding
  ├─ narrative 1: 输入到 sink 的控制没有暴露已确认攻击路径
  └─ narrative 2: 本地状态写入受到 fencing，远端重试具有可恢复身份
```

拆成两条是有价值的，因为它们依赖不同的证据，也可能独立改变 verdict。参数化 SQL 不能证明并发发布安全；claim token 也不能证明文件路径安全。把它们塞进一条 narrative，会让 source、sink、control 和 proof gap 混在一起。

> 这个例子也说明，多条 no-actionable narrative 仍需准确描述控制边界。数据库 fencing 能阻止 stale owner 提交本地状态，但不能撤销已经发出的 GitHub 请求。Heartbeat、marker reconciliation 和稳定远端身份可以降低并协调重复副作用风险，却不等于远端原子 exactly-once。因而第二条 narrative 的合适命题是“本地提交受到 fencing，远端重试依赖可恢复身份”，而不是“完全防止重复 GitHub 副作用”。
