# Narrative-First Review

语言：[English](NARRATIVE_FIRST_REVIEW.md) | 中文

本文是 [NARRATIVE_FIRST_REVIEW.md](NARRATIVE_FIRST_REVIEW.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

analyzer 的输出不是“随手列几个发现”，而是围绕 narrative 来组织。这里的 narrative 不是空泛猜测，而是一个带有独立证据和 verdict 的可审查分析方向。它可以解释 confirmed issue、plausible risk、inconclusive path，也可以表示某个方向已经审过且结论是 no-actionable-finding。

这样做的目的，是避免 agent 一边读代码一边不断堆零散 observation，最后只留下一个模糊印象。相反，系统希望 agent 先收敛出一组可比较的解释，并给出清晰优先级。也就是说，输出的基本形状是：

- 一组 narratives（每条有整数 `priority`，`1` 最高）
- 必要时再加少量 materially competing alternatives，并通过 `priority` 体现先后
- 最后再给 overall verdict，并用 `overview` 承载 reviewer-facing summary

这套模型有几个约束：

- 如果返回 narratives，每条都必须带唯一的 `priority`
- `confirmed-vulnerability` 和 `confirmed-defect` 要和 overall verdict 保持一致
- 当某条 narrative 的 `verdict=confirmed-vulnerability` 时，必须落到具体 location、`flow_review.source_facts`、`flow_review.sink_facts`，而不是只给抽象判断
- no-actionable narrative 应该说明被审查的方向、用来排除 actionable concern 的仓库证据，以及仍然重要的 proof gaps
- `support_review.proof_gaps` 用来记录某个 narrative 还缺什么证据

对读者来说，最重要的区别是：这个系统不是先问“有没有 checklist 上的漏洞类型”，而是先问“哪些审查方向值得保留下来，以及每个方向的证据支持什么 verdict”。漏洞类型、CWE 和 verdict 都是围绕这个 narrative-first 结构往外展开的，而不是反过来先定一个标签，再去拼证据。

这套结构不只服务 analyzer，也会被后续阶段继续消费。mitigator 不会对一整份报告平均用力，而是优先围绕高优先级、且 verdict 为 `confirmed-vulnerability` 或 `confirmed-defect` 的 narratives 判断“是否值得修、修哪一处、最小修复边界应该落在哪里”；verifier 也不是重新自由发挥一轮分析，而是会结合 analyzer 报告（含 narratives、priority 与 verdict）和 mitigation 结果做独立复核。换句话说，narrative-first 不只是输出格式，也是 analyzer、mitigator、verifier 三个阶段之间共享的工作对象。
