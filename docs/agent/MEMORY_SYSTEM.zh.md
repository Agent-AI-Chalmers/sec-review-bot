# Agent Memory System

语言：[English](MEMORY_SYSTEM.md) | 中文

本文为 [MEMORY_SYSTEM.md](MEMORY_SYSTEM.md) 的中文译文；如有差异，以英文版为准。

参考资料：

- [LangMem Core Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)
- [LangMem: How to Extract Episodic Memories](https://langchain-ai.github.io/langmem/guides/extract_episodic_memories/)
- [OpenAI Codex: Memories](https://developers.openai.com/codex/memories)
- [Claude Code: How Claude remembers your project](https://docs.anthropic.com/en/docs/claude-code/memory)
- [TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [OpenAI API: Working with evals](https://developers.openai.com/api/docs/guides/evals)
- [Persistent Memory | Hermes Agent](https://hermesagent.org.cn/en/docs/user-guide/features/memory)

agent 记忆机制是一个正在快速发展的领域：新的概念论文、开源库和产品方案仍在不断出现。复杂路线可以参考 TencentDB-Agent-Memory 这类系统，它把 memory 做成带有分层长期记忆、短期符号记忆、异构存储和可追溯检索的完整基础设施。

目前本项目主要学习 Claude Code 和 Codex，尤其是 Claude Code。它们的公开 memory 形态没有引入复杂的多个层级、数据索引、查询或 RAG 系统，而是更接近 skills 的文件化组织方式：用 progressive disclosure 组织 memory 文档，启动时只注入路由索引，实质性的规则、模式、注意事项和例子放在更细的主题文件里。

简单来说，可以把这类机制理解成：

```text
memory/
  MEMORY.md
  topics/
    python-path-traversal.md
```

其中 `MEMORY.md` 是启动时注入的路由索引，`topics/*.md` 保存具体经验。Claude Code / Codex 这类产品级 coding agent 可以在运行中读取、写入 memory，也会配套自动整理 memory 的机制。

本项目实现的是 Claude Code Memory 的一个子集：

- 我们只收集**安全审查经验**。按 LangMem 的分类，这属于 procedural memory，也就是可复用的审查流程和判断经验；不收集用户偏好（画像）。
- 主 agent 当前只读取维护后的 memory，不直接写 memory；写入、筛选和维护由后续异步流程完成。

## 核心产物

- `trajectories`：主 agent 完成审查后留下的执行轨迹。
- `observations`：从 trajectories 中提取出的可复用经验。
- `memory`：维护后的经验材料。

> 这里的 `trajectory` 按时间记录一次 agent 任务中的消息和工具交互，供后续检查和经验提取。其他系统也可能把类似产物称为 `trace` 或 `rollout`。

```text
主 agent
  ├─ 写入 trajectories
  └─ 读取 memory

extraction
  ├─ 读取 trajectories
  ├─ 对照已有 system prompt 与 skills 指导
  └─ 写入 observations

maintenance
  ├─ 读取 observations
  └─ 更新 memory
```

extraction 从一次 review 的阶段 trajectories 中提取可复用经验，例如 analyzer、mitigation、verification 的执行轨迹，并写成 observation。system prompts 和 `/skills` 下的全部 bundled skills 都算是 agent 已经有的指导；observation 应该在此基础上增加有证据支持、可长期复用的经验，否则就不产生 observation。

maintenance 会读取 extraction 产生的 observations，并把有用经验并入 memory。

- 不能凭常识创造新的安全审查经验；只能整理已有 memory，或吸收 selected observations 中足够稳定、可复用的经验。
- 可以合并、压缩、改写、重命名、拆分 topic，缩短 `MEMORY.md`，并在内容已经合并后删除过期或重复的 topic 文件。
- 不应该把 observations 原样追加进 memory；弱的、一次性的或过度依赖单次 run 的 observation 应该跳过或压缩掉。

## 生命周期

主 agent 只读取维护后的 memory 视图，不直接写 memory。prompt 里只注入使用规则和 `MEMORY.md` 启动索引；相关 topic 文件可以再按需通过普通 filesystem tools 读取。

经验产出走异步链路，无论如何都不影响正常流程（指 review）。

大致流程就是异步检查：

- 来源：issue 或 pull-request review 发布 trajectories 后，会进入异步 memory 处理。repository review 则会按每个实际存在 trajectories 的 case 形成一个 extraction unit。
- extraction 会分别处理各个 review，并产出 pending observations。
  - 可以并发执行多个 extraction。
<!-- doc-default: MEMORY_MAINTENANCE_SCHEDULE_DEFAULT_INTERVAL_SECONDS; source=agents/src/sec_review_agents/entrypoints/memory_maintenance_worker/schedules.py -->
<!-- doc-default: MEMORY_MAINTENANCE_PENDING_THRESHOLD; source=agents/src/sec_review_agents/workflows/memory/maintenance.py -->
<!-- doc-default: MEMORY_MAINTENANCE_PENDING_MAX_AGE; source=agents/src/sec_review_agents/workflows/memory/maintenance.py -->
- maintenance 定时检查，达到阈值或者时间过长就处理：maintenance trigger schedule 默认每小时运行一次。只有 pending observations 至少有 10 条，或者最老的 pending observation 已经等待至少 1 天时，才启动 maintenance。
  - maintenance 不可并行，同一时间只有一个；但是一次会处理多条 observations；
  - 用 `processed` 表示已经审阅并处理过，不表示经验一定被吸收进 memory（如上会做判断）。

## 治理

memory 不会让提取出的经验自动变可靠。重要经验仍然需要人审计、二次整理，并判断它是否应该继续留在 memory。

memory 应该保持小而可审计。它一旦长成笔记堆，就应该通过合并、改写、删除来整理，或者把重要材料提升到 prompts、skills 等地方。

当材料已经超出 memory 的职责时，检索应该建立在专门系统上。客户记录、用户画像和文档库需要明确的 schema、owner、权限、保留策略、评估和运维流程；search 或 RAG 不能让一个膨胀的 memory tree 变健康。

`MEMORY.md` 有启动注入上限。超过这个上限，说明 memory 已经欠整理了：maintenance 应该缩短索引、把细节下沉到 topic 文件，而不是把截断当成正常检索路径。

## 一些设计取舍

下面的选择都基于本项目的场景：大量并发的审查 agent 收集安全审查经验。场景不同，可以合理地做出不同选择。

### 没有用户偏好记录

Hermes Agent 等系统用 `USER.md` 记录用户偏好和身份信息。代码审查没有需要画像的用户，所以本项目不维护。如果场景改变，加一个 `USER.md` 和 `preference/` 目录就够了。

### 没有热读写

memory 写入不在主 agent 的关键路径上，原因有两个：

1. 并发。同一时间往往有许多审查任务在运行，每个任务里又有多个阶段 agent。如果它们都直接改写存放在文件里的 memory，就会互相冲突；加锁让写入排队，又会把等锁和写入的耗时带回主流程。
2. 没有 supervisor。单个阶段 agent 缺少全局视角，仅靠自身很难稳定产出足够好的长期经验。

因此主 agent 只留下 trajectories，由异步 extraction 和 maintenance 写入 memory。这牺牲了即时记忆，换来更清楚的来源、更稳定的主流程，以及更容易审计和回滚的 memory 更新。

当只有一个台前 agent/session、确实有 supervisor、且 memory 还要收集用户偏好时，就可以考虑热读写。这三个条件通常同时出现在个人助理 agent / coding agent 中。

### 没有做的

- 没有向量检索。
- 没有 `session_search`（查询以前的对话细节）。
- 没有自动 skills 生成。它对个人 agent 可行，但正式产品必须先证明每次生成的改动确实有提升。
