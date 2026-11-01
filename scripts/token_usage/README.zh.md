# Token 用量汇总

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

本目录提供一个辅助脚本，用于根据本地运行轨迹汇总 token 用量和有效补丁成本。

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

## 定价

价格来自 OpenRouter 的公开模型列表。脚本按各阶段记录的 `model_id` 查找价格：完整的 `<provider>/<model>` ID 必须精确匹配；只有数据源中恰好存在一个同名模型时，才会按不带 provider 的 `<model>` 名称匹配。数据源中不存在的模型，或多个 provider 共用的模型简称，都会报告为**成本未知**，不会猜测价格。

- 每次运行都实时获取价格，不在磁盘上缓存。因此，报告不依赖机器之前碰巧获取过的价格。
- 报告头部显示 `fetched_at`，即本次价格快照的 UTC 时间。这是唯一的时间戳，不另外记录每次运行的报告生成日期，因此报告内容只取决于输入和本次获取的价格。
- JSON 输出中的 `pricing.used_prices` 记录报告实际使用的模型价格；数据源中不存在的模型记为 `null`。这样无需保存完整价格表，也能根据报告本身解释成本数字。

模型名称映射由调用方负责，脚本不会代为映射：轨迹中记录的 `model_id` 必须对应价格源中的模型。无法匹配的模型会报告为未知，不会静默套用错误价格。

数据源只有实时接口，不提供历史价格，因此之后无法查询过去某一时刻的价格；报告只能采用获取时的价格，或保留未知状态。

OpenRouter 是转售平台的模型价格索引，其价格可能与模型服务商的官方价格不同。这里的成本应视为参考估算，而非实际账单。数据源未提供某模型的缓存读取价格时，缓存输入按该模型的非缓存输入费率估算，不会当作免费；缺少输入或输出价格的模型则报告为成本未知。当前价格源没有缓存写入费率字段，因此包含缓存创建 token 的阶段也会报告为成本未知，而不是将这些 token 的费用记为零。

## 有效补丁成本

默认表格同时显示：

- `TOTAL / all`：观测到的总用量。
- `TOTAL / effective_patch`：计入最终补丁生成路径的用量。

`effective_patch` 用于比较工作流结构，不替代总成本统计。

对于三阶段加反馈的工作流：

- 无重试：`effective_patch = analyzer.initial + mitigator.initial`
- 有重试：`effective_patch = analyzer.initial + all mitigator attempts + verifier attempts except the final verifier`

即有重试时，计入初始 analyzer、所有 mitigator 尝试，以及除最后一轮之外的 verifier 尝试。

默认表格中的 `efficiency` 为：

```text
effective_patch.total_tokens / total.total_tokens
```

AI 轮次统计包含缺少用量元数据的 assistant 消息。`ai_messages_with_usage_count` 单独报告带用量信息的消息数；某一轮没有用量信息，不代表它没有消耗 token。PatchEval 汇总不会将仅观测到部分用量的 token 总数计入平均值，并会在元数据中列出用量缺失或不完整的任务。
