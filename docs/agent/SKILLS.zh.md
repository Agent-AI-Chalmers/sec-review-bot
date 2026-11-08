# Agent Skills

语言：[English](SKILLS.md) | 中文

本文为 [SKILLS.md](SKILLS.md) 的中文译文；如有差异，以英文版为准。

本文说明本项目如何选择、准备、挂载和读取内置技能（Skill）。Skill 为 Agent 提供按需读取的专业知识，不替代审查工作流。

## Skills 是什么

Skill 是 Agent 可以按需读取的本地能力说明。`SKILL.md` 通常是入口，配套文件可以保存更详细的参考材料。

原理介绍见：

- [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [Claude Skills overview](https://claude.com/docs/skills/overview)
- [Agent Skills Specification Overview](https://www.mintlify.com/anthropics/skills/spec/overview)

## 渐进式披露

Skill 采用渐进式披露：中间件先提供名称和用途等元数据，Agent 需要时再读取 `SKILL.md` 和配套文件。

原理讲解见：

- [Agent Skills Specification Overview: Progressive Disclosure](https://www.mintlify.com/anthropics/skills/spec/overview)
- [Progressive Disclosure in Agent Skills](https://www.marthakelly.com/blog/progressive-disclosure-agent-skills)

典型目录结构是：

```text
skills/
  cwe/
    SKILL.md
    references/
      cwe-699-agent-navigation.md
```

`SKILL.md` 是入口。旁边文件保存更细的参考材料，`SKILL.md` 应说明 Agent 什么时候需要读取它们。

## LangChain / deepagents 的模型与边界

在本项目使用的版本中，LangChain 本身还缺少完善的 Skills 封装。deepagents 提供了 `SkillsMiddleware`，通过文件系统发现 skills 并加载元数据：

- 调用方配置一个或多个来源目录。
- 中间件在来源目录下寻找 `<skill>/SKILL.md`。
- 中间件读取 `SKILL.md` 的元数据，让 Agent 知道有哪些技能可用。
- Agent 随后通过文件工具读取完整的 `SKILL.md` 和配套文件。

`/skills` 不是 deepagents 硬编码路径。真正的约定是：

```text
<source>/<skill>/SKILL.md
```

本项目将来源目录挂载为 `/skills/`，所以 Agent 看到的是 `/skills/cwe/SKILL.md`。这个路径是项目约定，不是 deepagents 的要求。

deepagents 只读取调用方交给它的 source path，不负责替某个工作流挑选或过滤 skills。本项目会先做这一步：把已声明的 skills 从包 resources 复制到一个临时小目录，再把这个目录挂载成 `/skills`。Agent 看到的只有自己声明过的 skills。

## 本项目的设计原则

### Skill 选择层级

有些外部 skill 或 command 覆盖的能力，在本项目里已经由公开工作流和对应 review 阶段实现。例如 Anthropic 的 [`security-review.md`](https://github.com/anthropics/claude-code-security-review/blob/main/.claude/commands/security-review.md) 描述的是“做安全审查”，OrchestKit 的 [`review-pr.md`](https://github.com/yonatangross/orchestkit/blob/main/plugins/ork/commands/review-pr.md) 描述的是“审查 PR”。在这里，它们不是一个单独 skill。

内置 skills 位于项目目标的下一层。它们为 review 工作流补充可复用的安全知识。

当前知识层包括：

- CWE 分类导航和 scanner finding triage；
- Web、CI、memory/numeric、cryptography、concurrency/resource、OS boundary、parser/protocol、software supply chain 和 authorization 中按具体安全机制拆分的 reference。

领域归属按正在审查的机制划分。几个容易混淆的边界是：

- 进程调用和文件系统 authority 归 OS boundary；
- 对象构建归 parser/protocol；
- Web 与 CI 只负责各自 surface 上的敏感数据暴露；
- dependency selection 与 install/build 执行归 supply-chain security；
- 对象与操作授权、服务身份、委托 authority 和 confused deputy 归 authorization security。

一份 reference 只有同时满足以下条件才应纳入：

- 判断规则足够稳定，可以长期维护；
- 通过选择性读取，不会把特定生态的材料带入无关 review；
- 能在普通 source-to-sink、reachability 和 authority 推理之外改变安全判断。

不要把容易变化的版本/default 矩阵、漏洞目录或推荐清单固化进内置 reference。某个仓库声明的平台版本确实需要这些信息时，应在该次 review 中查询当前的一手资料。

### 开发者来源说明

内置技能配有面向开发者的来源说明，位置是：

```text
sec_review_agents/resources/skill_source_notes/
```

这些文件记录规则的权威来源，以及规则适用的条件和限制。

#### 来源说明的维护要求

来源说明按参考文件或较小的规则组维护，用于说明规则依据，不能只列链接。至少记录：

- 该 reference 负责什么，以及相邻的哪些机制不由它负责；
- 会改变判断的 operational claim，尤其是报告/拒绝条件、防护检查是否充分、默认行为和例外；
- 权威一手来源及可定位的章节、API、规则或其他 locator；
- 适用限制，包括语言、平台、协议、library 和版本前提；
- 足够明确的适用范围和例外，使维护者能区分有来源支持的规则与相邻但没有来源支持的结论。

Repository 报告阈值、工作流 ownership 和 skill 打包决策应标成 project policy，不能冒充外部标准结论。不必追溯每句解释性文字，但不能用一个宽泛来源链接替代缺乏支持的 operational rule。当默认行为会改变判断时，应按 repository 实际依赖或目标版本重新核验。

### 新增或更新内置 Skills

新增或修改内置 skill 时：

1. 把材料放在 `sec_review_agents/resources/skills/<skill-name>/` 下。`SKILL.md` 是入口。
2. `SKILL.md` 元数据应该足够一般，能用于 discovery；同时也要足够精确，让 Agent 能判断什么时候该读。不要把 description 写成某个测试的一次性提示。
3. 默认采用 `SKILL.md` 加少量精确 `references/` 文件。只有存在具体需求时才加入 templates 或 assets；除非文件系统 backend 和 permission model 已明确支持 skill 执行，否则不要加入 `scripts/`。
4. 把会改变判断的规则及其权威来源记录到 `sec_review_agents/resources/skill_source_notes/`。
5. 在目标 Agent 或阶段对应的 `skills.py` 中声明需要的 skill。
6. 确保目标 backend 消费该声明，先准备 allowlisted view，再挂载到 `/skills`，并为该 Agent session 启用 skills middleware。
7. 为 skill 准备和 backend exposure 增加聚焦测试。模型案例按 [`agents/tests/skills/README.md`](../../agents/tests/skills/README.md) 中记录的结构维护。
