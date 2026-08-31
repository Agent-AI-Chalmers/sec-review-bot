# Review Intent

语言：[English](REVIEW_INTENT.md) | 中文

本文是 [REVIEW_INTENT.md](REVIEW_INTENT.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

`review_intent` 记录调用方希望本次运行优先服务什么意图。

它有两个字段：

```json
{
  "review_intent": {
    "objective": "audit",
    "repair_mode": "no-test-changes"
  }
}
```

- `objective`：review 目标，取值为 `audit` 或 `repair`。
- `repair_mode`：可选的修复阶段约束，取值为 `test-changes-allowed` 或 `no-test-changes`。省略时 runner 按 `test-changes-allowed` 处理。

这两个字段相关，但不是同一个决策。`objective` 改变 workflow 如何对待输入 claim；`repair_mode` 只约束进入修复后的最终 patch。

## Objective

### `audit`

当调用方没有明确要求修复，或输入 claim 可能不成立、被夸大、已经修复、或不能在当前仓库中确认并修复时，应使用 `audit`。

默认行为：

- 把 report、alert、issue 正文、PR description、case statement 和提供的位置都当成需要验证的 claim。
- 对宽泛的历史问题、CVE 相关报告、扫描器结果和 issue 叙述保持怀疑，尤其是它们和当前仓库证据绑定很弱时。
- 当仓库证据不支持原始 claim 时，允许缩小范围、降低结论强度或拒绝该 claim。
- `plausible-risk` 和 `no-actionable-finding` 是有效终点，不是失败。
- 不为了避免保守结论而继续无边界扩展。
- 不为了“报告存在”而强行制造 patch。

### `repair`

当用户或上游系统已经表达修复意图时，应使用 `repair`。

默认行为：

- 把 report、issue、advisory、CVE、alert 和提供的位置当成可信度较高的修复线索。
- 不把主要精力放在推翻漏洞上，除非仓库证据显示目标明显不适用、已经修复、无法定位或内部矛盾。
- 把引用的位置当成起点，而不是完整修复边界。
- 做足够的范围扩展，判断修复范围是局部、共享，还是仍无法确定。
- 为后续修复识别兼容性约束和窄补丁风险。
- 当仓库证据显示既有行为应该继续安全工作时，优先选择保持兼容的解释。

`repair` 不允许凭空编造发现，也不是盲目服从报告。它仍然要求仓库证据。区别只是默认方向：推进到正确修复，而不是重新争论用户是否应该要求修复。

## Repair Mode

`repair_mode` 约束修复输出：

- `test-changes-allowed`：最终 patch 可以包含合理的配套测试改动。
- `no-test-changes`：agent 会被要求不要在最终 patch 中包含测试改动；测试只能作为临时验证手段。

`repair_mode` 不决定是否应该相信输入 claim。它只约束进入修复后的 repair stage。

这是写进 prompt 的修复约束，不是程序层面的强制校验。runner 不会判断哪些路径算测试文件，也不会按路径规则拒绝文件改动。

## Workflow 映射

- `issue-review` 接受 `objective = "audit"` 和 `objective = "repair"`。
- `pull-request-review` 当前要求 `objective = "audit"`。
- `repository-review` 当前要求 `objective = "audit"`。
- 所有 workflow 都可以接收 `repair_mode`；mitigator 会把它作为面向 agent 的修复阶段 patch 边界。

对 issue review：

- issue 自动触发：`review_intent.objective = "audit"`，因为自动触发时还没有人明确做出“请修”的决断。
- issue 手动 audit：`@<app-slug> review audit`。
- issue 手动 repair：`@<app-slug> review repair`，对应 `review_intent.objective = "repair"` 和 `review_intent.repair_mode = "test-changes-allowed"`。
- issue 手动 repair 且最终 patch 不包含测试改动：`@<app-slug> review repair no-test-changes`，对应 `review_intent.objective = "repair"` 和 `review_intent.repair_mode = "no-test-changes"`。
