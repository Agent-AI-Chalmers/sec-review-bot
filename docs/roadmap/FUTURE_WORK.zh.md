# 将来工作

语言：[English](FUTURE_WORK.md) | 中文

本文是 [FUTURE_WORK.md](FUTURE_WORK.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

这里记录以后值得探索的方向。每项分别记录提出时间和解决时间，✅ 表示已完成，⏳ 表示待完成。提出时间以 Git 中首次记录的日期为准，解决时间以对应实现合入的日期为准，均使用北京时间。

## 平台适配

| 状态 | 工作项 | 提出时间 | 解决时间 |
| --- | --- | --- | --- |
| ⏳ | 在 `apps/github-integration/` 旁边增加 GitLab integration。 | 2026-08-31 | 待解决 |

## Agent 能力提升

| 状态 | 工作项 | 提出时间 | 解决时间 |
| --- | --- | --- | --- |
| ✅ | 增加更多 skills。 | 2026-08-31 | 2026-10-16 |
| ✅ | 给 prompts 增加更多 few-shot 例子。 | 2026-08-31 | 2026-09-28 |
| ⏳ | 支持配置 agent 工作语言。 | 2026-08-31 | 待解决 |
| ⏳ | 完善 experience 审查、评估和提升路径。 | 2026-08-31 | 待解决 |
| ⏳ | 增加廉价的应用层安全防护。评估使用 [Jev](https://docs.typesafe.ai/concepts/use-case-map) 等决策模型审查动作，以及使用 [Little Canary](https://github.com/hermes-labs-ai/little-canary) 感知提示注入；结合模型检测、静态检查与规则驱动的审计（启发式，比如拒绝访问宿主密钥），衡量漏报、误报、延迟与成本。 | 2026-10-31 | 待解决 |
| ⏳ | 等 [langchain-quickjs](https://github.com/langchain-ai/deepagents/tree/main/libs/partners/quickjs) 成熟后评估其适用性。 | 2026-10-31 | 待解决 |
