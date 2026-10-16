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

因此，本项目内置 skills 选择比项目目标低一层的材料：CWE 分类导航、finding triage，以及 Web、CI、memory/numeric、cryptography、concurrency/resource、OS boundary、parser/protocol、software supply chain 和 authorization/delegation 的窄领域参考。领域归属按机制划分：进程调用和文件系统 authority 归 OS boundary，对象构建归 parser，Web 与 CI 只负责各自 surface 上的敏感数据 sink，dependency selection 与 install/build execution 归 supply-chain security，非浏览器服务身份、委托 authority 和 confused deputy 归 authorization/delegation security。它们补充 agent 的安全知识和判断材料，不改变既有流程。

即使某条判断规则只适用于特定生态，只要它稳定且 reference 会被选择性读取，就可以纳入。除非仓库声明的平台版本确实需要，否则排除容易变化的版本/default 矩阵、漏洞目录和推荐清单。稳定本身仍不够：reference 必须能在普通 source-to-sink 和 authority 推理之外改变安全判断。

### Developer Source Notes

内置 skills 保留面向开发者的 source notes，位置是：

```text
sec_review_agents/resources/skill_source_notes/
```

这些文件给人保留来源链接、示例和维护说明，不暴露给 agent skill view。

### Source Note 维护契约

Source note 应按 reference 或较小的规则组维护。它是证据账本，不是普通链接列表。至少记录：

- 该 reference 负责什么，以及相邻的哪些机制不由它负责；
- 会改变判断的 operational claim，尤其是报告/拒绝条件、guard 是否充分、默认行为和例外；
- 权威一手来源及可定位的章节、API、规则或其他 locator；
- 适用限制，包括语言、平台、协议、library 和版本前提；
- 规则准入后，对应的正例、反例和未知边界 JSON 案例；
- 对应 case ID，或者不需要模型测试的明确理由。

Repository 报告阈值、workflow ownership 和 skill 打包决策应标成 project policy，不能冒充外部标准结论。不必追溯每句解释性文字，但不能用一个宽泛来源链接替代缺乏支持的 operational rule。当默认行为会改变判断时，应按 repository 实际依赖或目标版本重新核验。

### 新增或更新内置 Skills

新增或修改内置 skill 时：

1. 把材料放在 `sec_review_agents/resources/skills/<skill-name>/` 下。`SKILL.md` 是入口。
2. `SKILL.md` metadata 应该足够一般，能用于 discovery；同时也要足够精确，让 agent 能判断什么时候该读。不要把 description 写成某个测试的一次性提示。
3. 默认采用 `SKILL.md` 加少量精确 `references/` 文件。只有存在具体需求时才加入 templates 或 assets；除非 filesystem backend 和 permission model 已明确支持 skill execution，否则不要加入 `scripts/`。
4. 如果 skill 受外部来源、示例或来源筛选决策影响，把这些内容记录到 `sec_review_agents/resources/skill_source_notes/`。不要通过 `/skills` 暴露 source notes。
5. 在目标 agent 或 stage-local 的 `skills.py` 里声明 skill。不要为了让 skill 可见，就把 skill name 写进文档、backend helper 或 runtime 准备代码。
6. 确保目标 backend 消费该声明，先准备 allowlisted view，再挂载到 `/skills`，并为该 agent session 启用 skills middleware。
7. 为 skill 准备和 backend exposure 增加聚焦测试。模型行为案例放在 [`agents/tests/integration/llm/skill_cases/`](../../agents/tests/integration/llm/skill_cases/README.md) 下的 JSON 中，并只选择有实际用途的 `prompted`（明确提示）、`natural` 或 `contrast` modes。Natural 案例必须显示模型成功读取了预期 skill 和 reference；仅仅答对不算成功。Contrast 会记录 baseline，但不要求 baseline 必须失败。
