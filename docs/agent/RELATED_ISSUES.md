# Agent-Related Issues

Language: English | [中文](RELATED_ISSUES.zh.md)

This page records design judgments about agent capability, context, cache, and compression in this project.

## Context Limits and Compression Mechanisms

Long conversations and repeated tool calls can exceed a model's context window, so a deployment needs a way to handle that limit. Compression and trimming are possible strategies; proactive use also requires evaluating evidence loss and actual cost.

For coding-agent compression settings, see the [Claude Code documentation](https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code) and [Codex configuration reference](https://developers.openai.com/codex/config-reference). Whether and when this project compacts context depends on its own runtime configuration.

Proactive compression does not necessarily reduce cost or improve judgment. Consider these risks:

1. Summaries reinterpret raw evidence and may lose details.
2. Prompt cache may be broken.

Cache is especially important. Stable long context with a high cache-hit rate is not necessarily more expensive than a short summary with a low cache-hit rate. If compression makes the prompt prefix change every round, cheap cache reads may become more expensive cache misses.

The following calculation reuses prices from the original notes only as an example, not a current provider quote. Assume uncached input costs 120 times cached input and exclude the cost of generating a summary. If the original would hit cache but the summary would not, the summary must be smaller than `1 / 120` of the original, about `0.83%`, to reduce the input cost of one subsequent request:

```text
120,000 tokens original cache hit: 120,000 * 0.025 / 1,000,000 = 0.003 CNY
5,000 tokens summary cache miss:     5,000 * 3     / 1,000,000 = 0.015 CNY
```

Token reduction alone does not establish savings: include summary-generation cost, the number of later requests, and changes in cache hits. Compaction must also preserve evidence needed to continue the review.

---

Agent design also has other mechanisms to suppress pathological context growth, such as:

1. Oversized tool output: filesystem tools have budgets. `read` has file-size, scanned-byte, and line-window limits; `grep` / `glob` / `ls` have result-count, traversal-count, and time limits. Docker `execute` output is also truncated by `AGENT_DOCKER_MAX_OUTPUT_BYTES`.
2. Infinite agent tool loops: `AGENT_GRAPH_MAX_STEPS` or `AGENT_GRAPH_RECURSION_LIMIT` can limit LangGraph recursion. This limit constrains agent / tool-call steps, not the token count of a single AI call.

---

A historical batch using DeepSeek V4 Pro reported a maximum single-call input of 210,292 tokens, about 21% of the 1M-token window used in that record. The notes omit the date, full model version, and artifact locations. This is a historical observation, not a guarantee that other tasks will stay within the limit or that the model currently offers the same window.

This may be because this project is not an infinite conversation system. A single issue / PR / repository review has clear input, stage boundaries, and structured output. It is not an infinite-dialogue agent or a free-form creative agent, which may limit context growth, but does not guarantee that difficult tasks stay within the limit.

Even so, having a default compression mechanism is still a good fallback.

The current fallback is LangChain `SummarizationMiddleware` with a project-specific handoff prompt. A run usually begins with one caller-supplied stage input, so compaction must preserve that input boundary and keep user requests separate from repository and tool content.

## Should Agents Read Repository Instructions and Documentation Broadly?

Agents should not be required by default to read repository instructions and documentation broadly before addressing a problem. Reading should serve the current task, rather than making familiarity with the entire repository a prerequisite.

A better approach combines two practices:

1. **Load repository guidance from `AGENTS.md` at startup.** Supply common project requirements and essential documentation pointers.
2. **Start from the given task description.** Investigate code against the issue, PR, or case objective, consulting related documentation as needed.

These practices work together: repository guidance supplies background, while the task description directs the investigation.

### Load Repository Guidance from AGENTS.md at Startup

- **Code does not explain every contract.** Intended compatibility, deployment assumptions, and architectural constraints may live in documentation. An agent that only follows the reported code path can miss them.
- **A stable entry point reduces discovery work.** The [AGENTS.md specification](https://agents.md/) provides a predictable place for project instructions, build commands, and conventions. A short, maintained entry point can avoid a broad documentation search.
- **Common requirements need not be repeated.** Keeping build commands, test requirements, and development conventions in `AGENTS.md` and loading it at the start of a task reduces what users need to repeat in each issue or PR.

The value depends on the file. Loaded instructions consume attention on every task. Outdated requirements, unrelated instructions, or directions to read the entire repository can misdirect the agent or cause unnecessary exploration. Automatically loading an entry point does not require loading every document it links to.

### Start from the Given Task Description

- **Finding and reading context takes time.** Asking an agent to “find all relevant documentation” can keep expanding its reading scope. [Anthropic's context-engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) recommends a small set of high-signal context and on-demand retrieval, while acknowledging exploration latency and dead ends.
- **Task authors must state the goal.** [GitHub's coding-agent guidance](https://docs.github.com/en/copilot/using-github-copilot/coding-agent/best-practices-for-using-copilot-to-work-on-tasks) calls for clear descriptions and complete acceptance criteria. [Claude Code's best practices](https://code.claude.com/docs/en/best-practices) asks users to state preferences that code cannot reveal. An agent cannot be expected to guess unstated requirements quickly and accurately.
- **Let the task guide further reading.** With or without a preloaded `AGENTS.md`, agents can inspect relevant code, callers, tests, and documentation. GitHub also notes that agents can often locate code without exact file paths. Users need not supply an implementation plan.

On-demand reading can still miss a documented constraint. A concise entry point can help expose important requirements, but neither it nor a generic instruction to read more guarantees that every contract will be found.

## Is the Agent Auditing or Repairing?

The system explicitly distinguishes `audit` / `repair` through `review_intent.objective`. `review_intent.test_changes` can also constrain whether the final mitigation patch may contain test changes, independently of the objective. Therefore, whether the agent is currently auditing or repairing is not guessed by the model on the spot, and is not implied by output text; it is part of the input contract.

The objective is selected by the caller, not a guarantee that a vulnerability exists. GitHub Integration selects `audit`; the local issue CLI lets the user select the objective.

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
