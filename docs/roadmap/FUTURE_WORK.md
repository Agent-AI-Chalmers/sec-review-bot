# Future Work

Language: English | [中文](FUTURE_WORK.zh.md)

This page records directions that are worth exploring later. Each item records when it was proposed and resolved; ✅ means complete and ⏳ means pending.

> Proposal dates use the first recorded date in Git; resolution dates use the corresponding implementation merge date.

## Platform Adapters and General Features

| Status | Work item | Proposed | Resolved |
| --- | --- | --- | --- |
| ⏳ | Add an account system and design access permissions. | 2026-10-31 | Pending |
| ⏳ | Build a standalone website independent of platform integrations, with richer user-facing functionality. | 2026-10-31 | Pending |
| ⏳ | Add a GitLab integration beside `apps/github-integration/`. | 2026-08-31 | Pending |

## Agent Capabilities

| Status | Work item | Proposed | Resolved |
| --- | --- | --- | --- |
| ⏳ | Add inexpensive application-level security defenses. Evaluate action review with decision models such as [Jev](https://docs.typesafe.ai/concepts/use-case-map) and injection sensing with [Little Canary](https://github.com/hermes-labs-ai/little-canary); combine model-based detection with static checks and rule-driven auditing (heuristics, such as denying access to host secrets), and measure missed attacks, false positives, latency, and cost. | 2026-10-31 | Pending |
| ⏳ | Reassess the suitability of [langchain-quickjs](https://github.com/langchain-ai/deepagents/tree/main/libs/partners/quickjs) once it matures. | 2026-10-31 | Pending |
| ⏳ | Support configurable agent working language. | 2026-08-31 | Pending |
| ⏳ | Improve experience review, evaluation, and promotion paths. | 2026-08-31 | Pending |
| ✅ | Add more skills. | 2026-08-31 | 2026-10-16 |
| ✅ | Add more few-shot examples for prompts. | 2026-08-31 | 2026-09-28 |
