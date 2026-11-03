# Token 用量汇总

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

本目录提供一个辅助脚本，用于根据本地运行轨迹汇总 token 用量和有效补丁用量。

Token 字段遵循 OpenTelemetry GenAI 语义：`input_tokens` 和 `output_tokens` 是包含各类子项的总量。`cache_read_tokens` 和 `cache_creation_tokens` 是 `input_tokens` 的子集，`reasoning_tokens` 是 `output_tokens` 的子集。派生字段 `uncached_input_tokens` 从 `input_tokens` 中减去上述两类缓存 token。

这是仓库级报告脚本，直接读取各阶段的轨迹文件。

运行前先安装 agents 包：

```bash
cd agents
uv sync --group test
source .venv/bin/activate
cd ..
```

脚本不会通过修改 `sys.path` 来查找 `agents/src`。

## 使用方法

汇总一个或多个本地运行目录：

```bash
# 默认：表格
python -m scripts.token_usage.summarize \
  /abs/path/to/local-run-xxx \
  /abs/path/to/local-run-yyy

# 详细文本
python -m scripts.token_usage.summarize --raw /abs/path/to/local-run-xxx

# CSV
python -m scripts.token_usage.summarize --csv /abs/path/to/local-run-xxx

# JSON
python -m scripts.token_usage.summarize --json /abs/path/to/local-run-xxx
```

输入可以是包含 `artifacts/` 的运行目录，也可以是集成部署直接写出的产物根目录，例如 `.agent-artifacts/run-20260926T144116Z-348e955e`。

## 不做成本估算

本报告只统计观测到的 token。价格刻意留给人来换算：只有实际付费账户的上下文才能决定价格——官方价还是转售价、合同折扣、batch 或错峰价、缓存读写规则、context 阶梯、赠送额度、币种以及价格表日期。自动化数字无法知道这些，因此报告不输出任何价格；也不提供开关，因为开关只会重新制造同样的假精确。

如果确实需要金额，必须手动对照一份显式、固定的价格表换算，并至少记录：

- 价格来源及其日期；
- 每个 `model_id` 如何映射到价格条目；
- 使用的 input、output、cache read、cache write 费率；
- 阶梯、缓存和折扣假设；
- 排除了哪些因素。

结果应视为一份写明假设的分析，而不是本报告的一个字段。不要只用 token 数比较不同 provider 的成本。

## 有效补丁用量

默认表格同时显示：

- `TOTAL / all`：观测到的总用量。
- `TOTAL / effective_patch`：计入最终补丁生成路径的用量。

`effective_patch` 用于比较工作流结构，不替代总量统计。

对于三阶段加反馈的工作流：

- 无重试：`effective_patch = analyzer.initial + mitigator.initial`
- 有重试：`effective_patch = analyzer.initial + all mitigator attempts + verifier attempts except the final verifier`

即有重试时，计入初始 analyzer、所有 mitigator 尝试，以及除最后一轮之外的 verifier 尝试。

默认表格中的 `efficiency` 为：

```text
effective_patch.total_tokens / total.total_tokens
```

AI 轮次统计捕获到的模型响应，包含 summarization middleware 和 subagent 的响应，即使用量元数据缺失也计入。`ai_messages_with_usage_count` 单独报告带用量信息的模型响应数；某一轮没有用量信息，不代表它没有消耗 token。

轨迹格式见[transcript 契约](../../contracts/agent-transcript/v1/SPEC.zh.md)。

## 用量来源与完整性

<!-- doc-default: model-call-accounting; source=loading.py -->
`usage_source` 表示统计来源：`model-calls` 为模型调用记录，`trajectory` 为规范的纯消息轨迹，`mixed` 为两者的混合汇总。

`usage_complete` 表示记录正常完成，且已观察到的调用都有用量。为 false 时，总量只包含已知用量。规范的纯消息轨迹覆盖有限，标记为不完整。

`model_call_count` 和 `model_calls_with_usage_count` 分别表示已观察到的调用数和带用量的响应数。AI 轮次统计捕获到的模型响应。
