# PatchEval 适配脚本

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

在 PatchEval 用例上运行 agent、导出补丁并汇总评测结果。以下命令均在仓库根目录执行。

## 安装与配置

安装依赖：

```bash
uv sync --project agents --group test
```

将 [Agent-AI-Chalmers/PatchEval](https://github.com/Agent-AI-Chalmers/PatchEval.git) 克隆到 `PatchEval/`。在 `agents/.env` 及其引用的 `MODEL_PROVIDERS_CONFIG_TOML` 中配置模型服务。运行基准镜像需要可用的 Docker。

所有 variant 和组件配置的生成沙箱均关闭外部网络（`AGENT_DOCKER_NETWORK_MODE=none`）。PatchEval 入口会强制应用此设置，即使宿主机环境启用了联网。依赖应已包含在基准镜像中；宿主机的模型 API 调用仍可正常进行。

<!-- doc-default: patcheval.environments; source=PatchEval/patcheval/datasets/environments.json -->
生成阶段将工作副本挂载到项目原路径，并保留预装依赖。准备阶段自动应用 [environments.json](https://github.com/Agent-AI-Chalmers/PatchEval/blob/main/patcheval/datasets/environments.json) 中已验证的逐案例 PATH 等环境配置，并从派生镜像中删除顶层评测材料。遇到未知兄弟目录时停止准备。

## 运行单个用例

```bash
AGENT_SANDBOX_BACKEND=docker \
uv run --project agents python -m scripts.patcheval.run_patcheval \
  --cve CVE-2023-41039 \
  --dataset PatchEval/patcheval/datasets/patcheval_runtime_subset_cleaned.json \
  --output-dir .agent-workspace-patcheval
```

命令会输出运行目录，结果和日志保存在其中。如果希望通过批量运行器管理单个 CVE，可在下一节命令中添加 `--only CVE-ID`。

## 批量运行

长时间运行请使用 `screen` 或 `tmux`。在该会话中设置模型和功能开关，然后先检查队列：

```bash
uv run --project agents python -m scripts.patcheval.pool \
  --tag PATCHEVAL-RUN-01 --variant end-to-end-default \
  --jobs 4 --timeout-seconds 10800 --max-failures 4 --dry-run
```

去掉 `--dry-run` 即可启动。`--jobs` 限制当前 pool 的并发尝试数；`--timeout-seconds` 限制每次执行的时长，包含工作区准备阶段。`--max-failures` 在执行失败达到指定次数后停止派发，在途任务继续完成；它不统计官方评测失败数。

`--variant` 选择工作流与输入变体，不配置 Skills/Joern/Memory。重复传入可以选择多个变体，省略则运行完整的可执行矩阵。`--tag` 用于命名批次，不配置其能力。审计、导出和汇总时应使用相同的 tag 和 variant 选择。

正式对照实验可添加 `--freeze-inputs`，固定输入和配置。开始时使用新 tag，续跑时保持相同执行设置；改变条件需要另建 tag。目前不支持冻结的 Memory 消费：启用 Memory 并配置 Catalog URL 的运行，需要使用普通的非冻结执行。

对于 default 工作流，可选的 `--skip-final-verifier` 会省略最后一次允许的修复重试之后的验证。第一轮 verifier 仍决定是否重试。所有参与比较的实验条件应采用相同策略。

## 查看进度与续跑

```bash
uv run --project agents python -m scripts.patcheval.audit \
  --tag PATCHEVAL-RUN-01 --variant end-to-end-default --summary-only
```

批量运行的结果和日志位于 `.agent-workspace-patcheval-<CVE>-<TAG>/`。运行完成表示执行生成了补丁产物，不表示官方评测通过。

再次执行批量运行命令即可继续：已完成的运行会被跳过，包括生成空补丁的运行。失败或中断的尝试，需要检查日志后显式重试：

```bash
uv run --project agents python -m scripts.patcheval.pool \
  --tag PATCHEVAL-RUN-01 --variant end-to-end-default \
  --only CVE-2023-41039 --resume-incomplete \
  --jobs 1 --timeout-seconds 10800 --max-failures 4 --dry-run
```

保持原有执行设置，包括先前使用的 `--skip-final-verifier`。确认重试范围后去掉 `--dry-run`。宿主机崩溃或强制终止后，应先检查未完成的任务和残留容器，再恢复运行。

## 导出补丁与汇总结果

导出选中变体的补丁：

```bash
uv run --project agents python -m scripts.patcheval.collect_patcheval_patches \
  --tag PATCHEVAL-RUN-01 --variant end-to-end-default --fill-from-dataset
```

默认拒绝未完成的任务。如果实验协议要求为这些任务提交空补丁，请显式添加 `--incomplete empty`。其他提交策略见 `--help`。

使用官方 PatchEval evaluator 评测导出的补丁，具体步骤见[评测指南](../../evaluation/cve-issue/README.md)。随后汇总结果：

```bash
uv run --project agents python -m scripts.patcheval.summarize_patcheval_evaluation \
  --tag PATCHEVAL-RUN-01 --prefix PATCHEVAL-RUN-01 \
  --variant end-to-end-default
```

将 `--prefix` 设置为 evaluator 实际使用的输出前缀。如果补丁导出到了其他目录，请设置 `--patch-input-dir`。

统计本地运行的 token 用量与成本：

```bash
uv run --project agents python -m scripts.token_usage.summarize \
  .agent-workspace-patcheval-CVE-2023-41039-PATCHEVAL-RUN-01/local-run-*
```

PatchEval 汇总使用 `effective_patch` 成本口径，排除不再改变补丁的最后一轮 verifier；价格为参考估算，不代表实际账单。详细说明见 [token 用量与成本](../token_usage/README.zh.md)。各命令也提供 `--help`。
