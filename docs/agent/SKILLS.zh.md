# Agent Skills

语言：[English](SKILLS.md) | 中文

本文是 [SKILLS.md](SKILLS.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

本文说明本项目如何选择、准备、挂载和读取内置 agent skills。

## Skills 是什么

skill 是 agent 可以按需读取的本地能力说明。`SKILL.md` 通常是入口，旁边可以放更细的参考材料。

原理介绍见：

- [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [Claude Skills overview](https://claude.com/docs/skills/overview)
- [Agent Skills Specification Overview](https://www.mintlify.com/anthropics/skills/spec/overview)

## Progressive Disclosure

skills 使用 progressive disclosure。middleware 先暴露 skill metadata；agent 需要时再读取 `SKILL.md` 和 companion files。

原理讲解见：

- [Agent Skills Specification Overview: Progressive Disclosure](https://www.mintlify.com/anthropics/skills/spec/overview)
- [Progressive Disclosure in Agent Skills](https://www.marthakelly.com/blog/progressive-disclosure-agent-skills)

典型目录形状是：

```text
skills/
  cwe/
    SKILL.md
    references/
      cwe-699-agent-navigation.md
```

`SKILL.md` 是入口。旁边文件保存更细的参考材料，`SKILL.md` 应说明 agent 什么时候需要读取它们。

## LangChain / deepagents 的模型与边界

LangChain 本身没有强治理的通用 skill 模型。deepagents 的 `SkillsMiddleware` 更像一个轻量 filesystem 协议：

- 调用方配置一个或多个 source path。
- middleware 在 source path 下寻找 `<skill>/SKILL.md`。
- middleware 读取 `SKILL.md` metadata，让 agent 知道有哪些 skill 可用。
- agent 后续通过 filesystem tool 读取完整 `SKILL.md` 和 companion files。

`/skills` 不是 deepagents 硬编码路径。真正的约定是：

```text
<source>/<skill>/SKILL.md
```

本项目使用 `/skills/` 作为 source path，所以 agent 看到的是 `/skills/cwe/SKILL.md`。这是项目约定，不是 deepagents 的要求。

deepagents 只读取调用方交给它的 source path，不负责替某个 workflow 挑选或过滤 skills。本项目会先做这一步：把已声明的 skills 从 package resources 复制到一个临时小目录，再把这个目录挂载成 `/skills`。agent 看到的只有自己声明过的 skills。

## 本项目的设计原则

### Skill 选择层级

有些外部 skill 或 command 覆盖的能力，在本项目里已经由公开 workflow 和对应 review stage 实现。例如 Anthropic 的 [`security-review.md`](https://github.com/anthropics/claude-code-security-review/blob/main/.claude/commands/security-review.md) 描述的是“做安全审查”，OrchestKit 的 [`review-pr.md`](https://github.com/yonatangross/orchestkit/blob/main/plugins/ork/commands/review-pr.md) 描述的是“审查 PR”。在这里，它们不是一个单独 skill。

因此，本项目内置 skills 选择比项目目标低一层的材料：CWE 分类导航、Web 安全参考、CI 安全参考、source / sink / guard，以及常见误报先例。它们补充 agent 的安全知识和判断材料，不改变既有流程。

### Developer Source Notes

内置 skills 保留面向开发者的 source notes，位置是：

```text
sec_review_agents/resources/skill_source_notes/
```

这些文件给人保留来源链接、示例和维护说明，不暴露给 agent skill view。

### 新增或更新内置 Skills

新增或修改内置 skill 时：

1. 把材料放在 `sec_review_agents/resources/skills/<skill-name>/` 下。`SKILL.md` 是入口。
2. `SKILL.md` metadata 应该足够一般，能用于 discovery；同时也要足够精确，让 agent 能判断什么时候该读。不要把 description 写成某个测试的一次性提示。
3. 默认采用 `SKILL.md` 加少量精确 `references/` 文件。只有存在具体需求时才加入 templates 或 assets；除非 filesystem backend 和 permission model 已明确支持 skill execution，否则不要加入 `scripts/`。
4. 如果 skill 受外部来源、示例或来源筛选决策影响，把这些内容记录到 `sec_review_agents/resources/skill_source_notes/`。不要通过 `/skills` 暴露 source notes。
5. 在目标 agent 或 stage-local 的 `skills.py` 里声明 skill。不要为了让 skill 可见，就把 skill name 写进文档、backend helper 或 runtime 准备代码。
6. 确保目标 backend 消费该声明，先准备 allowlisted view，再挂载到 `/skills`，并为该 agent session 启用 skills middleware。
7. 为 skill 准备和 backend exposure 增加聚焦测试。如果改动依赖模型行为，用 gated LLM integration 或 contrast test 验证，并保留输出以确认模型是否发现并读取了 skill。
