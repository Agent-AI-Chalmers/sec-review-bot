# Review Intent

语言：[English](REVIEW_INTENT.md) | 中文

本文为 [REVIEW_INTENT.md](REVIEW_INTENT.md) 的中文译文；如有差异，以英文版为准。

`review_intent` 记录**调用方**要求**被调用方**服务哪一种 review 目标，外加对最终补丁的可选约束。

**调用方**、**被调用方**与**最终用户**是三个不同角色，这个区分在这里很关键：

- **调用方（caller）**是真正调用 review 执行侧、设置 `review_intent` 的程序：GitHub Integration、PatchEval harness，或本地 CLI 运行。
- **被调用方（callee）**是 review 执行侧：接收请求、校验 `review_intent` 并运行 review 工作流的 Execution Worker。
- **最终用户（end user）**通过调用方交互——例如在 GitHub issue 下评论 `@<app-slug> review`。GitHub 评论命令不提供 `objective` 参数，由 GitHub Integration 固定使用 `audit`。用户可以通过 `--test-changes deny` 设置 `test_changes`。

*本地 Issue CLI 则允许通过 `--review-objective audit|repair` 选择目标。*

调用方如何选择 objective 是它自己的产品决策，不是 `review_intent` 决定的。GitHub Integration 始终使用 `audit`，因为它转发的是别人写的 issue 或 pull request——一个未经证实的说法。

*我们特意将 PatchEval harness 设计为可使用 `repair`，以评测针对已知 CVE 的修复能力。*

## 字段

```json
{
  "review_intent": {
    "objective": "audit",
    "test_changes": "deny"
  }
}
```

- `objective`：review 目标，取值为 `audit` 或 `repair`。
- `test_changes`：对最终修复补丁的可选约束，取值为 `allow` 或 `deny`。省略时执行侧按 `allow` 处理。

`objective` 决定工作流如何对待输入报告中的主张；`test_changes` 只约束修复阶段输出的最终补丁。

## 审查目标

### `audit`

调用方没有把输入主张当作已确认，因此工作流先验证它。当该 claim 可能不成立、被夸大、已经修复、或不能在当前仓库中确认并修复时，应使用 `audit`。

默认行为：

- 将报告、告警、Issue 正文、PR 描述、问题摘要和位置提示都视为待验证的线索。
- 对宽泛的历史问题、CVE 相关报告、扫描器结果和 issue 叙述保持怀疑，尤其是它们和当前仓库证据绑定很弱时。
- 当仓库证据不支持原始主张时，允许缩小范围、降低结论强度或否定该主张。
- `plausible-risk` 和 `no-actionable-finding` 是有效终点，不是失败。
- 不为了避免保守结论而继续无边界扩展。
- 不因为有人报告问题就强行生成补丁。

### `repair`

调用方已经确认输入是一个可修复目标——例如 PatchEval harness，其输入是已知 CVE。只有手握可信输入的调用方才应发送它。

默认行为：

- 将问题报告、安全公告、CVE、告警和位置提示视为可信度较高的修复线索。
- 不把主要精力放在推翻漏洞上，除非仓库证据显示目标明显不适用、已经修复、无法定位或内部矛盾。
- 把引用的位置当成起点，而不是完整修复边界。
- 做足够的范围扩展，判断修复范围是局部、共享，还是仍无法确定。
- 为后续修复识别兼容性约束和窄补丁风险。
- 当仓库证据显示既有行为应该继续安全工作时，优先选择保持兼容的解释。

`repair` 不允许凭空编造发现，也不是盲目服从报告。它仍然要求仓库证据。区别只是默认方向：推进到正确修复，而不是重新争论这个修复是否该被提出。

Objective 指定 Analyzer 的调查目标，不预设调查结论，也不改变结果字段的含义。例如，以修复为目标展开调查，并不意味着 Analyzer 必须认定存在漏洞，或 Mitigator 必须生成补丁。

## 测试改动约束

`test_changes` 约束修复阶段输出：

- `allow`：最终补丁可以包含合理的配套测试改动。
- `deny`：Agent 会被要求不要在最终补丁中包含测试改动；测试只能作为临时验证手段。

`test_changes` 不决定是否应该相信输入主张。它只约束进入 mitigation 之后的阶段。

这是通过提示词传递给 Mitigator 的约束，不是程序层面的强制校验。执行侧不会判断哪些路径算测试文件，也不会按路径规则拒绝文件改动。
