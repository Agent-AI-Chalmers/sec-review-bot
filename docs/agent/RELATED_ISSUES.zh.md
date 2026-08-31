# Agent 相关问题

语言：[English](RELATED_ISSUES.md) | 中文

本文是 [RELATED_ISSUES.md](RELATED_ISSUES.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

本文记录本项目在 agent 能力、上下文、缓存和压缩上的设计判断。

## 上下文上限和压缩机制探讨

对于真正用于生产的 agent，为了避免长对话或多轮工具调用触及上下文上限，上下文裁剪和压缩机制是必须的保底，不管最终是否会被触发。

一些 coding-agent 系统会把压缩当成接近上下文上限时的高水位保底，而不是主动降本手段。Claude Code 文档说明会在接近上下文上限时自动压缩（[Help Center](https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code)）；Codex 也暴露了 `model_auto_compact_token_limit`，作为自动历史压缩的 token 阈值配置（[config reference](https://developers.openai.com/codex/config-reference)）。

此外，也有主动压缩/裁剪的说法，想要达到降低成本、提升 LLM 注意力的目的。但是我个人觉得存疑。理由是：

1. 原始证据被二次解释，细节丢失。
2. prompt cache 可能被破坏。

尤其是 cache。稳定长上下文加高 cache hit，不一定比短摘要加低 cache hit 更贵。压缩如果让 prompt prefix 每轮变化，可能把原本便宜的 cache read 变成更贵的 cache miss。

以 DeepSeek V4 Pro 为例，cache miss 输入价格是 cache hit 的 120 倍。因此，如果一段原本能 cache hit 的上下文被压成新摘要，而摘要没有命中 cache，那么摘要必须小于原文的 `1 / 120`，也就是约 `0.83%`，输入成本才会更便宜。

```text
120,000 tokens 原文 cache hit:   120,000 * 0.025 / 1,000,000 = 0.003 元
5,000 tokens 摘要 cache miss:      5,000 * 3     / 1,000,000 = 0.015 元
```

所以总体来看，我认为压缩/裁剪机制是无可奈何的避免达到上下文上限的办法。

---

agent 设计里也有其他的机制用来遏制上下文的恶性增长，如：

1. 工具输出过大：filesystem 工具有预算限制。`read` 有文件大小、扫描字节和行窗口限制；`grep` / `glob` / `ls` 有结果数、遍历数和时间限制。Docker `execute` 也会按 `AGENT_DOCKER_MAX_OUTPUT_BYTES` 截断输出。
2. Agent 无限工具循环：可以通过 `AGENT_GRAPH_MAX_STEPS` 或 `AGENT_GRAPH_RECURSION_LIMIT` 限制 LangGraph recursion。这个限制约束的是 agent / tool-call steps，不是单次 AI 调用本身的 token 数。

---

具体到我们的项目，我们通过实验也发现了一件事，就是我们的 agent 从来没有达到上限过。根据使用 DeepSeek V4 Pro 的历史运行记录，单次 AI 调用的上下文输入峰值最高也就 210,292 tokens。DeepSeek V4 Pro 的公开 API 上下文长度是 1M tokens。也就是说，这批运行的最高峰值大约是 210K，只用了约 21% 的上下文窗口，还远没有接近上限。

这可能是因为我们的项目不是无限对话系统。一次 issue / PR / repository review 有清晰输入、阶段边界、结构化输出。它并不是无限对话的 agent，也不是自由创作的 agent，因此即便是很难的任务，也不会在规模上无比庞大。

不过虽然如此，有默认压缩机制仍然是很好的保底。

当前保底机制是 LangChain `SummarizationMiddleware` 加项目定制的 handoff prompt。一次运行通常从一条权威的阶段输入开始，所以压缩时必须保留这条输入的边界，并把用户要求和仓库/工具内容分开。

## Agent 到底是在审计还是修复？

系统通过显式 `review_intent.objective` 区分 `audit` / `repair`。当 objective 是 `repair` 时，还可以通过 `review_intent.repair_mode` 约束是否允许修改测试。因此 agent 当前是在审计还是修复，不是由模型临场猜测，也不是由输出文本暗示，而是输入契约的一部分。

objective 是用户选择的执行目标，不是漏洞一定存在的事实断言。

## 应该多大程度相信 agent 的输出？

不能把 agent 输出整体当成事实，也不能把它整体当成噪声。合理的信任边界取决于输出能否追溯到代码库事实。

模型自报的 `confidence` 或者类似语句不是证据。生产方通常会对自己的判断显得很自信，而消费方真正需要的是可追溯的依据。因此，本项目更看重输出是否能映射回文件位置、调用关系、具体行为、patch 内容、测试结果和 artifact 记录。

一个判断如果能从代码和运行证据中对应上，就可以被相对信任；如果只是 agent 对自身判断的信心描述，就不能作为高层决策依据。

## 多阶段 agent 是否只是把错误分散到多个阶段？

多阶段不能保证不出错，也不能消除错误传播。Analyzer 如果一开始分析错了，Mitigator 可能会沿着错误方向修复；Verifier 有机会挽救，但不能假设一定能挽救。

多阶段的价值不在于神奇地消除错误，而在于隔离不同任务的偏见。Analyzer 负责形成安全叙事，Mitigator 负责生成修复，Verifier 负责重新审查 patch 覆盖和回归状态。

Verifier 的独立性还通过靠 prompt 输入边界尽量维持。它需要接收必要的分析方向和 patch 上下文，否则无法聚焦；但它不会完整继承前序叙事，否则会失去重新验证的意义。

## 输出结构是在帮助判断，还是在诱导判断？

结构化输出不是中立的。对 agent 来说，输出格式本身就是 prompt 的一部分，因此字段名称、字段层级和字段之间的关系都会影响 agent 如何组织分析。

输出格式的字段组织方式也代表了作者对问题的认知方式：哪些信息被认为重要，哪些边界被认为需要单独表达，哪些判断需要从证据中拆开。这种认知模型会进入 agent 的分析过程。Schema 既帮助消费方读取结果，也会引导生产方按这些维度思考；需要避免的是让结构替代证据，或者让字段名制造虚假的确定性。
