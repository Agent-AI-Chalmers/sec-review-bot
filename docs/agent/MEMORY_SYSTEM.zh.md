# Agent Memory System

语言：[English](MEMORY_SYSTEM.md) | 中文

本文是 [MEMORY_SYSTEM.md](MEMORY_SYSTEM.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

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
- 主 agent 当前只读取整理后的 memory，不直接写 memory；写入、筛选和维护由后续异步流程完成。

## 核心产物

- `transcripts`：主 agent 完成审查后留下的过程记录。
- `observations`：从 transcripts 中提取出的可复用经验。
- `memory`：整理后的经验材料。

> 这里的 `transcripts` 指一次 agent 执行任务时留下的、可归档的过程记录；其他系统或语境里也常把类似产物称为 `trace`、`trajectory`（SWE-agent）或 `rollout`（Codex）。

```text
主 agent
  ├─ 写入 transcripts
  └─ 读取 memory

extraction
  ├─ 读取 transcripts
  └─ 写入 observations

maintenance
  ├─ 读取 observations
  └─ 更新 memory
```

extraction 从一次 review 的阶段 transcripts 中提取可复用经验，例如 analyzer、mitigation、verification 的过程记录，并写成 observation；如果没有可长期复用的经验，就不产生 observation。

maintenance 会读取 extraction 产生的 observations，并把有用经验并入 memory。

- 不能凭常识创造新的安全审查经验；只能整理已有 memory，或吸收 selected observations 中足够稳定、可复用的经验。
- 可以合并、压缩、改写、重命名、拆分 topic，缩短 `MEMORY.md`，并在内容已经合并后删除过期或重复的 topic 文件。
- 不应该把 observations 原样追加进 memory；弱的、一次性的或过度依赖单次 run 的 observation 应该跳过或压缩掉。

## 生命周期

主 agent 只读取整理后的 memory 视图，不直接写 memory。prompt 里只注入使用规则和有界的 `MEMORY.md` 启动索引；相关 topic 文件可以再按需通过普通 filesystem tools 读取。

经验产出走异步链路，无论如何都不影响正常流程（指 review）。

大致流程就是定时检查：

- 来源：review workflow 发布 transcripts 后，会登记一个待处理的 extraction job。
- extraction 定时检查，有就处理：extraction schedule 默认每 10 分钟运行一次，处理已登记的 extraction jobs 并产出 pending observations。
  - 可以并发处理多个 job。
- maintenance 定时检查，达到阈值或者时间过长就处理：maintenance trigger schedule 默认每小时运行一次。只有 pending observations 至少有 10 条，或者最老的 pending observation 已经等待至少 1 天时，才启动 maintenance。
  - maintenance 不可并行，同一时间只有一个；但是一次会处理多条 observations；
  - 用 `processed` 表示已经审阅并处理过，不表示经验一定被吸收进 memory（如上会做判断）。

> 10 条是经验设计，可调整

## 治理

memory 不会让提取出的经验自动变可靠。重要经验仍然需要人审计、二次整理，并判断它是否应该继续留在 memory。

memory 应该保持小而可审计。它一旦长成笔记堆，就应该通过合并、改写、删除来整理，或者把重要材料提升到 prompts、skills 等地方。

> 注：如果是**正式产品**，仅从 prompt engineering 的角度来看，这种行为也是需要审慎的，因为必须要证明改动是有提升的。但是如果是个人助理的 agent，可以考虑如自动 skills 生成，这样就是一个自治理的好系统了。

当材料已经超出 memory 的职责时，检索应该建立在专门系统上。客户记录、用户画像和文档库需要明确的 schema、owner、权限、保留策略、评估和运维流程；search 或 RAG 不能让一个膨胀的 agent memory 目录变健康。

`MEMORY.md` 有启动注入上限。超过这个上限，说明 memory 已经欠整理了：maintenance 应该缩短索引、把细节下沉到 topic 文件，而不是把截断当成正常检索路径。

## 一些设计取舍

### 没有用户偏好记录

最典型的例子就是 Hermes Agent。他们有 `USER.md`，这种记录用户偏好和身份信息的文件。但是我们的项目是代码审查，所以没有必要维护所谓的用户偏好。

---

但是如果情景变了，那就可以加了，而且甚至可以加的很自然：`USER.md` + `preference/` 目录就行。

### 没有热读写

本项目没有把 memory 写入放在主 agent 的主流程关键路径上，核心原因有两个：

1. 是多 agent 并发。多个 review、多个阶段 agent 或多个 repository case 同时运行时，如果它们都直接改长期 memory，会遇到直接的写冲突问题。文件化 memory 尤其如此。即使用文件锁串行化写入，也会把锁等待和写入延迟带回主流程。
2. 我们这里并没有所谓的 supervisor，且单个 agent 并不具有全局的视野，仅靠它自己，通常很难稳定地产生足够好的长期经验。

因此，当前实现只让主 agent 留下 transcripts，把经验写入、筛选和归并放到异步 extraction / maintenance 流程里。这样会牺牲一部分即时记忆体验，但换来更清楚的来源、更稳定的主流程，以及更容易审计和回滚的 memory 更新。

---

但是也要注意，一定要结合情景，比如：

- 假设台前工作的只有一个 agent/session
- 确实有一个 supervisor
- memory 不仅是收集经验，还要收集用户偏好

那么就是可以考虑热读写的。

意外的是，通常这三点集中的出现在个人助理 agent / coding agent 上。

### 其他

- 没有复杂的 DB 和 向量检索
- 没有 `session_search`（允许 agent 查询以前的对话细节）
- 自动 skills 生成（对个人 agent 是可行的，但是正式产品存疑，详细见上治理）
