# Bounded Verifier Feedback Retry

语言：[English](BOUNDED_VERIFIER_FEEDBACK_RETRY.md) | 中文

本文是 [BOUNDED_VERIFIER_FEEDBACK_RETRY.md](BOUNDED_VERIFIER_FEEDBACK_RETRY.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

## Summary

本文说明 shared review workflow 中 bounded verifier-to-mitigator feedback retry 模型。

基础下游路径是：

- `analyzer -> mitigator -> verifier`

当 verifier 判断一次 patch attempt 明显薄弱、不完整或有风险时，workflow 可以进行一次 bounded recovery pass：

- `analyzer -> mitigator(pass1) -> verifier(pass1) -> mitigator(pass2) -> verifier(pass2)`

这有意**不是**开放式循环。架构支持 retry budget，但 operating policy 仍然是 single-retry。

## Why This Exists

`verifier` 不只是 terminal audit stage。它也负责识别：

- incomplete patch coverage
- ineffective remediation
- unsafe fixes
- 不应继续驱动 patch scope 的 overstated analyzer claims

如果没有 bounded retry path，这个判断就是描述性的，而不是纠正性的。feedback retry mechanism 让 verifier 在保持 deterministic stop conditions 的同时变得 operationally useful。

---

这个机制还有结构性原因。single agent 通常可以在一次连续运行中验证并修改自己的 patch。multi-stage workflow 不能。一旦 analysis、mitigation、verification 被拆成独立阶段，verifier output 就只能 downstream，除非系统显式把它反馈给 mitigation。没有这个 feedback path，multi-stage design 会放弃一个基本的自我纠正循环。

---

Verifier-led retry 弱于 failed PoC、failed test 或另一个可直接复现的 failure signal。这些信号更强，因为它们来自运行代码，而不是模型判断。

但实践中，很多 security repair task 没有 runnable PoC、稳定 repro harness，或直接验证修复的测试。具备这些条件时，任务已经准备得异常充分。因此 verifier-led retry 不如 executable validation 权威，但适用于更常见的情况，并作为默认 fallback quality gate。

## Core Workflow

### Normal Path

- `analyzer -> mitigator -> verifier`

如果第一次 verifier result 可接受，workflow 结束。

### Recovery Path

- `analyzer -> mitigator(pass1) -> verifier(pass1) -> mitigator(retry) -> verifier(retry)`

retry 是对同一 scoped task 的 bounded revision pass。retrying mitigator 使用 previous attempt 和 verifier feedback 作为上下文，但从 prepared baseline workspace 重新开始，而不是把编辑叠在 previous patch 上。尤其是，retry path 留在 mitigation-verification path 上，不重新打开 analyzer。Analyzer 仍然是 baseline scope artifact，而 verifier objections 约束 retrying mitigation pass。

### Generalized Bounded Model

架构上，workflow 建模为：

- `analyzer -> mitigator -> verifier -> [feedback-guided mitigator -> verifier] * k`

其中：

- `k <= maxFeedbackRetries`
- operating policy 使用 `maxFeedbackRetries = 1`

重要性质是 budget，而不是具体数字。这个设计为适度的未来实验留出空间，同时避免把 workflow 变成 unbounded conversational loop。

## Resolution Next Step

Verifier output 将 patch coverage 与下一个 workflow action 分开：

- `patch_coverage`: patch 对 reviewed target claim 的覆盖程度
- `resolution_next_step`: verification judgment 之后应该发生什么

`resolution_next_step` 有三个值：

- `none`: 当前 verifier outcome 不需要后续动作。这是 `patch_coverage=full` 的正常值。
- `retry-ai`: 剩余 gap 具体、in scope，并且可能由一次 bounded AI mitigation retry pass 修复。
- `manual-review`: 剩余工作需要 human judgment、repository administrator action、credential rotation、deployment/configuration changes、history cleanup、cache/fork cleanup，或其他普通 workspace patch 之外的动作。

`partial` 不自动表示 retry。partial patch 可以暴露一个应当 retry 的 actionable code gap，也可以表示有用的 current-snapshot hardening，但剩余工作只能由人或 repository administrator 完成。

Examples:

- SSRF bypass 仍然存在于已 patch 的 URL/IP validation logic 中 -> `patch_coverage=partial`, `resolution_next_step=retry-ai`
- committed secret 已从当前 tree 移除，但仍存在于 git history 中 -> `patch_coverage=partial`, `resolution_next_step=manual-review`

## Retry Trigger Policy

Retry 由 `resolution_next_step=retry-ai` 驱动，而不是只由 `patch_coverage` 驱动。

Retry-eligible patch judgments 通常是 `partial` / `local-only` / `unresolved` / `misaligned`，但它们也必须携带 `resolution_next_step=retry-ai`。

更常见的 retry 模式是：

- analyzer 提供 partial 或 narrow framing
- mitigator 遵循该 framing
- verifier 判断 analyzer framing 不完整，并且 resulting patch 也是 `partial`、`local-only` 或 `misaligned`

这就是 retry 有用的情况。在这种情况下，verifier 不只是拒绝 patch。它也接管 retry pass 的 effective framing。

当 verifier 选择 `resolution_next_step=retry-ai` 时，它应该包含具体的 `patch_findings[]` 文本，让 retrying mitigator 获得 actionable patch-correction feedback，而不是模糊的 negative verdict。

设计意图很简单：只有当 verifier 产生了 actionable patch-correction feedback 时才 retry。这个机制不是为了重新打开每一个 unsuccessful review。

## Retry Context Model

### Retrying Mitigator

retrying mitigator 应被 framing 为 bounded revision pass，并接收：

- previous mitigation summary 的简短版本，包括 status、overview 和 changed files
- latest verifier result summary
- earlier verifier feedback 的 compact history projection

它的运行规则是：

- 把 verifier 报告作为主要修正信号
- retry 一旦开始，就把 verifier 视为本次 retry pass 的有效问题框定者
- 保留 analyzer 中仍然成立的发现，除非 verifier 明确提出质疑
- 当 analyzer claim 与 verifier concern 冲突时，优先采用 verifier 更安全的解释
- 把上一次尝试和 verifier feedback 作为修订上下文，但 retry patch 应从 prepared baseline workspace 重新生成，而不是叠加在上一次 patch 之上
- 上一次 mitigation summary 只用于理解上一次尝试做了什么，不作为 retry patch 的事实源
- 保持在原 issue、pull request 或 repository case scope 内
- 避免无关清理或大范围重构

### Retrying Verifier

retrying verifier 是 feedback-aware 的，但它的 independence 保持不变。

它应接收：

- previous verifier result
- previous verifier patch findings
- new mitigation summary
- new workspace patch
- earlier verifier feedback 的 history projection
- analyzer summary only when needed for continuity

这些 context 用来帮助 verifier 判断 earlier patch concerns 现在是：

- resolved
- still present
- superseded

retrying verifier 默认不应该重做完整 analyzer audit。Prior verifier judgments 是 continuity context，不是 binding authority。new patch 和 current repository evidence 仍然是新 verification decision 的基础。

## Context And History Policy

workflow 可以在本地保留完整 retry history，但 agent 应只接收适合当前任务的 **history projection**。

workflow 应保留：

- initial mitigation and verifier outcomes
- later retry attempts
- retry trigger reasons

完整 history 对以下事情有价值：

- auditability
- comparison between initial and revised outcomes
- downstream inspection

retrying mitigator 的 history projection 应围绕：

- original analyzer scope
- latest verifier feedback
- previous mitigation attempted 什么、改了哪些文件
- earlier verifier patch findings as a compact history snapshot

retrying verifier 的 history projection 应围绕：

- current patch and repository evidence
- previous verifier patch findings
- 足够 continuity，用于判断 new patch 是否 resolved、preserved 或 superseded those findings

Older verifier history 应结构化摘要，而不是盲目重放 raw full-text reports。

## Design Boundary

这个架构有意针对 **small retry budgets** 优化，而不是任意大的 `N`。

如果 retry budget 变大，预期成本也会变大：

- more context carry-forward
- longer prompts
- higher latency
- higher cost

这对于 bounded experimentation 是可以接受的，但这个设计的目标不是让大 retry counts 变得便宜或 structurally invisible。
