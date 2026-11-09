# CVSS v4 评分 Agent

语言：[English](CVSSV4.md) | 中文

本文为 [CVSSV4.md](CVSSV4.md) 的中文译文；如有差异，以英文版为准。

`cvss-v4-scoring` 是 `repository-review` workflow 的一部分。

## 为什么放在这里

CVSS v4 属于标准化任务。只要 Analyzer 已提供足够稳定、结构化的漏洞事实，打分本质上就是：

- 判定各个 base metric
- 生成 vector
- 计算 base score
- 输出 severity 与简要理由

因此难点主要在输入事实质量，而不是算分本身。

这里使用 Agent，是为了让 CVSS Scoring 能在有限的代码库上下文中核实与评分指标有关的事实，而不是只把 Analyzer 摘要映射成分数。也就是说，它应该利用仓库证据校准 `AV/PR/UI/AT/SC/SI/SA` 等关键判断，但不能重新变成一个开放式 Analyzer。

## 在系统里的用途

CVSS v4 打分用于**结果展示层的标准化风险表达**，而不是系统内部修复优先级主信号。

它主要承担：**帮助人类审查者快速理解 severity**。

## 设计边界

`cvss-v4-scoring` 负责：

- 读取 Analyzer 输出的结构化事实
- 在代码库副本中定向核实当前 case 的少量证据
- 判断当前 case 是否是独立可打分的 CVSS 对象
- 按 CVSS v4 Base 标准判定指标
- 输出 `vector`、`base_score`、`severity` 和各指标的判定理由
- 对加固建议、纵深防御、影响放大因素或依赖另一个独立漏洞才能利用的 case 输出 `not-scored`

`cvss-v4-scoring` 不负责：

- 全仓开放式探索新问题
- 替代 Analyzer 做漏洞确认
- 替代 Mitigator 决定修复策略
- 替代 Verifier 判断修复有效性

如果需要读代码，只应围绕当前 case 做定向核实，避免越界扩展问题范围。

## 代码库访问

CVSS Scoring Agent 不只是读取 Analyzer 结果。它也可以读取为当前阶段准备的代码库副本。该副本允许工具写入索引或缓存；prompt 要求只读调查，不修改被评分的代码。

这个能力的目的不是重新发现漏洞，而是解决打分中的局部不确定性，例如：

- 接口是否需要认证
- 漏洞入口是否真的是网络可达
- 影响是否局限于当前服务，还是有仓库证据支持对后续系统的影响
- Analyzer 中某个位置或输入来源事实是否与代码一致

因此它的代码读取边界是：

- 优先使用选中的 `verdict=confirmed-vulnerability` narrative 和已给出的位置或受影响路径
- 打开能帮助判定一两个 CVSS 指标的文件
- 不做全仓搜索式再审计
- 不把读到的无关问题扩展成新的 case
- 不用 mitigator/verifier 或修复后状态影响原始漏洞打分

## 何时不评分

CVSS Scoring Agent 只对**当前 case 本身**评分；读代码时发现的其他问题不纳入本次评分。

如果当前 case 只是提高另一个漏洞的影响，例如“容器未设置 `USER`，所以 RCE 成功后影响更大”，那么这个 case 是建议加固项 / 影响放大器，而不是独立 CVSS 对象。此时 CVSS 阶段应输出：

- `scoring_status: not-scored`
- `overview`
- `not_scored_reason`

这不是打分失败，而是一个明确结论：当前 case 不应被打分。

## 阶段位置与输入要求

- **位置**：在 Analyzer 之后，根据已分析的漏洞事实评分；不放在 Mitigator / Verifier 之后，避免引入修复后信息污染
- **前提**：Analyzer 事实质量决定打分质量上限
- **用途**：作为展示层标准分，不作为内部调度核心信号

## 参考资料

- FIRST CVSS v4.0 Specification Document: <https://www.first.org/cvss/v4-0/specification-document>
- FIRST CVSS v4.0 User Guide: <https://www.first.org/cvss/v4-0/user-guide>
