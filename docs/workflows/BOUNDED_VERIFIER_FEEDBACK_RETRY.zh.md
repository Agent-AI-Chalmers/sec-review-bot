# 验证反馈驱动的有限重试

语言：[English](BOUNDED_VERIFIER_FEEDBACK_RETRY.md) | 中文

本文为 [BOUNDED_VERIFIER_FEEDBACK_RETRY.md](BOUNDED_VERIFIER_FEEDBACK_RETRY.md) 的中文译文；如有差异，以英文版为准。

## 概要

基础下游路径是 `analyzer -> mitigator -> verifier`。如果 Verifier 在修复尝试中发现具体、可修复的问题，工作流可以执行有限的反馈重试：

- `analyzer -> mitigator -> verifier -> [feedback-guided mitigator -> verifier] * k`

<!-- doc-default: MAX_FEEDBACK_RETRY_ATTEMPTS; source=agents/src/sec_review_agents/review_stages/feedback_loop.py -->
代码常量 `MAX_FEEDBACK_RETRY_ATTEMPTS` 将 `k` 限制为 `1`。这不是部署配置项。修改上限需要同时考虑上下文增长、耗时和模型成本，并重新运行针对 agent 行为的聚焦验证。

## 为什么需要反馈重试

Verifier 不只是最后的审计阶段。它也负责识别：

- 安全目标覆盖不完整；
- 修复无效；
- 修改不安全；
- Analyzer 夸大问题，导致补丁范围不合理。

没有反馈重试路径，这些判断只能描述问题，不能推动修正。反馈重试让 Verifier 的判断能够推动后续修复，同时保持明确的停止条件。

---

这个机制还有结构性原因。单个 Agent 通常可以在一次连续执行中验证并修改自己的补丁。多阶段 workflow 将分析、修复、验证拆开后，Verifier 的输出默认只会向下游传递；要让它推动修正，系统必须显式反馈给 Mitigator。没有这条路径，多阶段设计就缺少一个基本的自我纠正循环。

---

Verifier 反馈来自模型判断，其证据强度通常弱于失败的 PoC、失败测试或其他可直接复现的失败信号，因为后者来自实际运行代码。

但很多安全修复任务没有可运行的 PoC、稳定的复现环境，或能直接验证修复的测试。具备这些条件时，任务已经准备得很充分。因此，Verifier 反馈虽然不如执行验证有力，仍能在缺少稳定复现方式时提供修正方向，作为默认的后备质量检查。

## 基本流程

- Analyzer 的结论不会阻止后续修复和验证阶段运行。
- Mitigator 根据证据决定是否修改代码；没有安全、合理的方案时可以不修改。
- Verifier 独立核查问题是否成立，以及修复处理是否合理；没有补丁也会核查。
- 只有 `next_step=retry-ai` 才会安排重试（见[验证后如何决定下一步](#验证后如何决定下一步)）；其他结果继续组装结果及执行后续交付步骤。
- 重试只重新执行修复和验证，不重新运行 Analyzer，原分析仍界定审查范围。Mitigator 从准备好的原始工作区重新生成补丁，并优先处理验证指出的问题。

## 验证后如何决定下一步

Verifier 分别输出：

- `coverage`：当前代码对本次实际核查的安全主张（`target_claim`）的解决程度，无论是否有补丁。原问题已修复或主张被证据否定时，也可以是 `full`；
- `regression`：回归检查、构建、测试或行为兼容性证据的结论，取值为 `passed`、`failed`、`not-run`、`not-applicable` 或 `unresolved`；
- `next_step`：验证之后需要采取的动作。

`next_step` 的取值为：

- `none`：无需后续动作。对于完成态 Verifier 判断，必须满足 `coverage=full`，且 `regression` 为 `passed`、`not-run` 或 `not-applicable`。
- `retry-ai`：有具体、范围内的安全缺口或已确认回归，预计可通过有限次数的修复重试处理。
- `manual-review`：未解决的回归证据决定了下一步，或剩余工作需要人工判断、管理员操作、密钥轮换、部署配置变更、历史清理、缓存或 fork 清理等补丁之外的动作。

`coverage` 和 `regression` 是独立判断。补丁即使完全解决安全问题，也可能破坏受支持的 API。此时可以是 `coverage=full`、`regression=failed`，但不能使用 `none`，应要求重试或人工处理。

如果还有独立、具体且可修复的安全缺口，即使 `regression=unresolved`，也可以请求重试；未解决的回归问题必须保留在 `findings` 中，并在重试后重新核查。如果下一步主要取决于该未解决问题，则使用 `manual-review`。特别是 `coverage=full` 且 `regression=unresolved` 时，必须使用 `next_step=manual-review`。

`coverage=partial` 不自动触发重试：剩余工作可能是可修改的代码缺口，也可能只能由管理员完成。例如：

- URL/IP 校验仍有 SSRF 绕过路径：`coverage=partial`、`next_step=retry-ai`。
- 可修复的安全缺口和未解决的回归证据同时存在：可以使用 `retry-ai`，但 `findings` 必须保留两项问题。
- `coverage=full`，但破坏了受支持的 API：`coverage=full`、`regression=failed`，要求重试或人工处理。
- 密钥已从当前代码中删除，但仍在 Git 历史中：`coverage=partial`、`next_step=manual-review`。

没有补丁时，充分证据也可以支持 `coverage=full`。有补丁时，不必要、无关或不安全的修改仍需记录在 `findings` 中，并要求后续处理，不能仅因当前安全目标已满足就批准交付。

## 何时触发重试

重试由 `next_step=retry-ai` 驱动，不能只看 `coverage`。

首次修复没有改文件，也可以重试：Verifier 若发现前一次遗漏的具体修复机会，应提供说明具体修复问题的 `findings`，并遵守同样的次数限制。

`partial`、`local-only`、`unresolved`、`misaligned` 等判断可能需要重试；`coverage=full` 但回归失败也可能需要重试。关键是验证反馈是否指出了范围内、可处理的问题，而不是结论标签本身。

更常见的重试模式是：

- Analyzer 提供的解释不完整或范围过窄；
- Mitigator 沿用该解释；
- Verifier 发现分析范围不完整，补丁也只是 `partial`、`local-only` 或 `misaligned`。

这时，Verifier 指出重试应优先核查的问题，其判断仍需根据当前仓库证据复核。

选择 `next_step=retry-ai` 时，Verifier 应在 `findings[]` 中提供具体修正问题，让 Mitigator 获得明确反馈，而不是模糊的否定结论。

只有反馈指出具体修正问题时才重试。这个机制不是为了重新开启每一次未成功的审查。

## 重试需要哪些上下文

### 再次执行的 Mitigator

再次执行的 Mitigator 进行一次有次数限制的修订，接收：

- 前一次修复的简要结果，包括概述和变更文件；
- 最新 Verifier 结果摘要；
- 更早 Verifier 反馈的精简历史。

它的运行规则是：

- 把 Verifier 报告作为主要修正信号；
- 优先核查 Verifier 指出的阻塞问题，再根据当前代码和执行证据决定是否修改、如何修改；
- 保留 Analyzer 中仍然成立的发现，除非 Verifier 指出的阻塞问题或当前代码证据要求修正；
- 修复已确认的问题；否定 Verifier 意见时，引用直接回应其质疑的代码或执行证据；
- 不因 Analyzer 和 Verifier 存在分歧就修改补丁；Verifier 建议的补丁形式并非强制要求，也不能为满足不安全的旧行为预期而削弱安全修复；
- 保留尚未解决的问题，供再次执行的 Verifier 评估；当未解决的证据或必要的人工判断决定下一步时，Verifier 应使用 `manual-review`；
- 把上次尝试和 Verifier 反馈作为修订上下文，但从准备好的原始工作区生成新补丁，不叠加上次修改；
- 前一次修复摘要只用于理解上次尝试做了什么，不作为新补丁的事实依据；
- 保持在原 Issue、PR 或仓库 case 的范围内；
- 避免无关清理或大范围重构。

### 再次执行的 Verifier

再次执行的 Verifier 了解先前反馈，但仍独立判断。

它应接收：

- 前一次 Verifier 结果；
- 前一次 Verifier 指出的补丁问题；
- 新的修复摘要；
- 新补丁；
- 更早 Verifier 反馈的精简历史；
- 为保持调查连贯所需的 Analyzer 摘要。

这些上下文帮助 Verifier 判断先前的补丁问题现在是：

- 已解决；
- 仍然存在；
- 已被新的判断或问题取代。

再次执行的 Verifier 默认不重做完整的 Analyzer 调查。先前的 Verifier 判断用于保持调查连贯，不是必须服从的权威。新补丁和当前仓库证据仍是本次验证的依据。

### 历史记录如何保留

workflow 保留完整重试历史（初次结果、后续重试和重试触发原因），用于审计和下游检查。Agent 只接收上文所述的 history projection；较早的 Verifier 历史按结构整理摘要，而不是重放完整报告。

## 设计适用范围

这套架构有意针对**少量重试**优化，而不是任意大的 `N`。

提高重试上限会增加：

- 需要向后传递的上下文；
- prompt 长度；
- 耗时；
- 成本。

这些代价可以作为有限实验的取舍，但本设计不以低成本支持大量重试为目标，也不能忽略它对上下文和流程的影响。
