# 仓库脚本

语言：[English](README.md) | 中文

本目录包含仓库级辅助脚本。它们不属于 `sec_review_agents` 包；这里的 Python 脚本也不会通过修改 `sys.path` 来查找 `agents/src`。

> [!NOTE]
> 这些脚本是为仓库维护者提供的便利工具，不是稳定的公共接口，可以随内部代码、本地环境和工作流调整，无需保留兼容层。按需使用即可。脚本失效时，优先更新或删除，不要为了兼容而把旧行为保留为契约。

## 目录结构

- `checks/`：仓库级文档检查及共用辅助代码。
- `dev/`：本地开发进程启动器。
- `ops/`：维护、调度和运维检查脚本。
- `experiments/`：模型和 Memory 提取探针。
- `replay/`：工作流和阶段重放工具。
- `execution_statistics/` 和 `tests/`：分别存放统计辅助代码和仓库脚本测试。

仓库级检查统一放在 `checks/` 中，从仓库根目录以模块方式运行。

## 检查入口

检查脚本应从仓库根目录执行，可重复运行：

```bash
# 检查本地 Markdown 链接。
python -m scripts.checks.markdown_links

# 检查正文是否存在固定列宽硬换行。
python -m scripts.checks.markdown_wrapping

# 检查中英文文档的标题结构是否对齐。
python -m scripts.checks.translated_doc_headings
```

`translated_doc_headings.py` 扫描所有已跟踪的 `*.zh.md` 文件，找到对应的英文 `.md` 源文件，检查标题层级和章节编号是否对齐。

## 本地辅助工具

运行依赖 agents 项目的脚本前，先安装或激活 agents 环境：

```bash
# 进入 agents 项目。
cd agents

# 安装依赖及测试依赖组。
uv sync --group test

# 返回仓库根目录。
cd ..
```

然后从仓库根目录以模块方式运行辅助工具：

```bash
# 在 sec-review-bot 仓库根目录激活环境。
source agents/.venv/bin/activate

# 查看 triage 重放工具的参数。
python -m scripts.replay.repository_triage --help
```

## 系统测试

提交测试、无需模型的冒烟测试探针和手动执行生命周期探针见[跨服务系统测试](../system-tests/README.md)，其中说明了前置条件、命令、覆盖范围、隔离方式和 CI 成本控制。

### Langfuse 运行统计探针

`ops/probe_langfuse_run_statistics.py` 从 [Langfuse Observations API v2](https://langfuse.com/docs/api-and-data-platform/features/public-api#v2) 读取一个审查的 `run_id`，输出只读 JSON 摘要。它查找 `sec_review_agent` 属于维护的 review-agent allowlist 的根节点，使用游标分页读取对应 traces 下的 `GENERATION` 模型调用记录，并且只接纳 Langfuse 回调作用域发出的调用。生产导出组件会抑制 provider SDK 的重复 spans；探针发现这类重复记录时，将其视为追踪采集回归。其余调用按 observation ID 去重，再按 Agent 和原生 provider/model 分组。

使用 agents 环境运行，以采用仓库锁定的 Langfuse SDK：

```bash
# 配置 Langfuse 访问凭据和地址，查询指定 run_id。
LANGFUSE_PUBLIC_KEY=... \
LANGFUSE_SECRET_KEY=... \
LANGFUSE_BASE_URL=https://your-langfuse.example \
uv --project agents run python -m scripts.ops.probe_langfuse_run_statistics <run_id>
```

输出描述的是 Langfuse 已观测到的调用。`complete_for_observed_calls` 表示返回的每条模型生成记录都有用量信息，不能证明所有调用均已上传。

## Memory 实验探针

- `experiments/memory_extract_observations.py` 对指定的执行轨迹文件或审查产物目录运行 memory extractor，输出 observation 和 extractor 执行轨迹。
- `experiments/memory_maintain.py` 直接调用主包的 memory maintainer，根据 observation 构建或更新本地记忆文件树。

这两个脚本直接读写本地文件，无需 Temporal、Memory Catalog、PostgreSQL 或对象存储。

```bash
# 从 observation Markdown 文件构建新的 Memory 文件树。
uv --project agents run python -m scripts.experiments.memory_maintain \
  observations/*.md --output-dir runs/memory-01

# 基于上一版文件树的副本吸收另一批 observations。
uv --project agents run python -m scripts.experiments.memory_maintain \
  observations-next/*.md --base-memory runs/memory-01/memory \
  --output-dir runs/memory-02
```

输入按参数顺序处理，使用不含扩展名的文件名作为 observation ID，且这些 ID 必须唯一。可用 `--deployment` 覆盖 maintainer 的模型部署。输出目录必须尚不存在，其中包含 `memory/`、记忆维护 Agent 执行轨迹和 `manifest.json`；清单记录输入哈希、基础文件树指纹、部署覆盖参数、时间戳、执行状态及成功输出的指纹。输入文件和基础文件树不会被修改。成功输出会移除暂存的 observation；失败尝试保留部分文件并记录失败状态。重试须使用新目录。learning 至少需要一条 observation；reorganization 必须提供 `--base-memory`，且不接收 observation。不自动分批或重试。

## 本地开发 Workers

从仓库根目录一起启动 Execution、Memory Extraction 和 Memory Maintenance Worker：

```bash
# 使用本地 Memory 开发配置启动 worker 进程组。
uv --project agents run python -m scripts.dev.dev_workers --env-file compose.memory.env
```

原 `sec-review-agents-memory dev-workers` 子命令已删除，改用上述命令。

这个开发启动器映射各角色的存储凭据，并在任一 Worker 退出或收到 SIGINT/SIGTERM 时停止 Worker 组。它依赖[本地 Memory 搭建说明](../docs/operations/LOCAL_MEMORY_DEVELOPMENT.zh.md)中的基础设施，不启动 Compose 服务。

## Memory 运维

从仓库根目录使用 agents 项目环境运行：

```bash
# 在 Temporal 中启动一次维护 workflow。
uv --project agents run python -m scripts.ops.memory_ops --env-file compose.memory.env maintain

# 在 Temporal 中手动启动一次仅整理已有记忆的 workflow。
uv --project agents run python -m scripts.ops.memory_ops --env-file compose.memory.env maintain --mode reorganization

# 创建或更新周期性维护触发计划。
uv --project agents run python -m scripts.ops.memory_ops --env-file compose.memory.env schedules maintenance ensure
```

<!-- doc-default: memory-maintenance-mode; source=scripts/ops/memory_ops.py -->
`maintain` 在 Temporal 中启动维护 workflow。默认的 `--mode learning` 处理待处理 observations；`--mode reorganization` 只整理当前生效记忆，不消费 observation，由人工手动触发。`schedules maintenance ensure` 创建或更新 learning 的周期触发计划。两者均需要配置好的 Temporal 服务；实际维护还需要 Worker、Memory Catalog 和对象存储。通过各子命令的 `--help` 查看连接、超时、批次及调度参数。
