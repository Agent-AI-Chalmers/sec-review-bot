# Agent-Related Issues

Language: English | [中文](RELATED_ISSUES.zh.md)

This page records design judgments about agent capability, context, cache, and compression in this project.

## Context Limits and Compression Mechanisms

For an agent that is truly used in production, context trimming and compression are a necessary fallback to avoid long conversations or multi-turn tool use hitting the context limit, regardless of whether the mechanism is ultimately triggered.

Some coding-agent systems treat compression as a high-watermark fallback rather than proactive cost optimization. Claude Code documents auto-compaction near the context limit ([Help Center](https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code)), and Codex exposes `model_auto_compact_token_limit` as the token threshold for automatic history compaction ([config reference](https://developers.openai.com/codex/config-reference)).

There is also the idea of proactive compression / trimming for reducing cost or improving LLM attention. I personally find that questionable, for the following reasons:

1. Raw evidence is reinterpreted, and details are lost.
2. Prompt cache may be broken.

Cache is especially important. Stable long context with a high cache-hit rate is not necessarily more expensive than a short summary with a low cache-hit rate. If compression makes the prompt prefix change every round, cheap cache reads may become more expensive cache misses.

For DeepSeek V4 Pro, cache-miss input price is 120 times the cache-hit input price. Therefore, if a piece of context that would have hit cache is compressed into a new summary, and that summary does not hit cache, then the summary must be smaller than `1 / 120` of the original text, about `0.83%`, for input cost to become cheaper.

```text
120,000 tokens original cache hit: 120,000 * 0.025 / 1,000,000 = 0.003 CNY
5,000 tokens summary cache miss:     5,000 * 3     / 1,000,000 = 0.015 CNY
```

Overall, I see compression / trimming as an unavoidable way to avoid hitting the context limit.

---

Agent design also has other mechanisms to suppress pathological context growth, such as:

1. Oversized tool output: filesystem tools have budgets. `read` has file-size, scanned-byte, and line-window limits; `grep` / `glob` / `ls` have result-count, traversal-count, and time limits. Docker `execute` output is also truncated by `AGENT_DOCKER_MAX_OUTPUT_BYTES`.
2. Infinite agent tool loops: `AGENT_GRAPH_MAX_STEPS` or `AGENT_GRAPH_RECURSION_LIMIT` can limit LangGraph recursion. This limit constrains agent / tool-call steps, not the token count of a single AI call.

---

For this project specifically, experiments also showed that our agents have never reached the context limit. Based on historical runs using DeepSeek V4 Pro, the highest context input peak for a single AI call was only 210,292 tokens. DeepSeek V4 Pro's public API context length is 1M tokens. In other words, the peak in this batch was about 210K, around 21% of the context window, still far from the limit.

This may be because this project is not an infinite conversation system. A single issue / PR / repository review has clear input, stage boundaries, and structured output. It is not an infinite-dialogue agent or a free-form creative agent, so even difficult tasks do not become unbounded in scale.

Even so, having a default compression mechanism is still a good fallback.

The current fallback is LangChain `SummarizationMiddleware` with a project-specific handoff prompt. A run usually begins with one authoritative stage input, so compaction must preserve that input boundary and keep user requests separate from repository and tool content.

## Is the Agent Auditing or Repairing?

The system explicitly distinguishes `audit` / `repair` through `review_intent.objective`. When the objective is `repair`, `review_intent.repair_mode` can also constrain whether test changes are allowed. Therefore, whether the agent is currently auditing or repairing is not guessed by the model on the spot, and is not implied by output text; it is part of the input contract.

The objective is the execution goal chosen by the user, not a factual assertion that a vulnerability definitely exists.

## How Much Should We Trust Agent Output?

Agent output should not be treated entirely as fact, and it should not be treated entirely as noise either. The reasonable trust boundary depends on whether the output can be traced back to repository facts.

Model-reported `confidence` or similar language is not evidence. Producers usually sound confident about their own judgments, while consumers actually need traceable support. Therefore, this project cares more about whether output can map back to file locations, call relationships, concrete behavior, patch content, test results, and artifact records.

If a judgment can be matched to code and runtime evidence, it can be trusted relatively. If it is only the agent's confidence description about its own judgment, it cannot be used as a high-level decision basis.

## Does a Multi-Stage Agent Merely Spread Errors Across Stages?

Multi-stage flow cannot guarantee correctness, and it cannot eliminate error propagation. If the Analyzer is wrong at the beginning, the Mitigator may repair in the wrong direction; the Verifier has a chance to recover, but we cannot assume it will always recover.

The value of multi-stage flow is not that it magically eliminates errors, but that it isolates biases from different tasks. The Analyzer forms the security narrative, the Mitigator generates the repair, and the Verifier rechecks patch coverage and regression status.

Verifier independence is also maintained as much as possible through prompt input boundaries. It needs to receive the necessary analysis direction and patch context, otherwise it cannot focus; but it does not fully inherit the previous-stage narrative, otherwise it would lose the meaning of re-verification.

## Is Structured Output Helping Judgment, or Inducing Judgment?

Structured output is not neutral. For the agent, the output format itself is part of the prompt, so field names, field hierarchy, and relationships between fields all affect how the agent organizes analysis.

The organization of output fields also represents the author's cognitive model of the problem: which information is considered important, which boundaries need separate expression, and which judgments need to be separated from evidence. This cognitive model enters the agent's analysis process. Schema helps consumers read results, and it also guides producers to think along those dimensions. What must be avoided is letting structure replace evidence, or letting field names manufacture false certainty.
