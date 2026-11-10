# 跨服务系统测试

语言：[English](README.md) | 中文

<!-- doc-default: system-tests.inventory; source=system-tests/ -->

这些冒烟测试使用跨包或跨语言边界的生产代码，不调用真实模型。下表列出它们在 CI 中的执行策略。以下命令均从仓库根目录运行。

## 冒烟测试清单

| 冒烟场景 / 入口                                                 | 验证的真实边界                                                                           | 主要断言                                                                                                                                   | CI 执行策略              |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| [Review Runs HTTP](review-runs-http/review-runs-http.test.mjs)  | GitHub Integration 的 Review Runs 客户端 → Review Runs HTTP                              | 成功的空响应不会触发 JSON 解析错误；JSON 响应仍能正常解析。                                                                                | PR 按路径触发 + 合并队列 |
| [run 提交](execution-submission/execution-submission.test.mjs)  | Review Runs 的 Execution API 客户端 → Execution Gateway HTTP → Temporal                  | 提交、重放相同提交并读取运行状态。在 Worker 执行前停止。                                                                                   | PR 按路径触发 + 合并队列 |
| [Memory Catalog 客户端](memory-catalog/test_memory_catalog.py)  | agents 包的 Memory Catalog 客户端 → Memory Catalog HTTP → PostgreSQL                     | 必须先确认；重复注册保持幂等；拒绝冲突的发布意图和错误凭据。                                                                               | PR 按路径触发 + 合并队列 |
| [输入包](input-bundle/test_input_bundle.py)                     | TypeScript 归档/上传 → RustFS → Python 输入准备                                          | 重复发布保持身份一致；工作区字节在传输后保持不变；拒绝错误摘要。                                                                           | PR 按路径触发 + 合并队列 |
| [Memory 操作员编辑](memory-operator-edit/test_memory_bff.py)    | UI BFF → Catalog/PostgreSQL + RustFS                                                     | 重放编辑不会创建额外修订；过期编辑产生冲突；恢复返回先前指针和可读取的产物。                                                               | PR 按路径触发 + 合并队列 |
| [执行生命周期](execution-lifecycle/test_execution_lifecycle.py) | Review Runs 协调 → Execution Gateway → Temporal/Worker → RustFS → Review Runs/PostgreSQL | 任务失败后能自动重试、执行能完成、运行文件可读取，且重新打开存储后仍能读取发布结果。安全分析使用预设结果，不调用真实模型或向 GitHub 发布。 | 仅手动执行               |

Review Runs HTTP 和 run 提交共用 `Smoke — Service Boundaries` job。Catalog 客户端、输入包和操作员编辑共用 `Smoke — Memory and Artifacts`，让选中的测试复用临时服务；各测试仍有独立的路径过滤器。手动工作流为 `Smoke — Execution Lifecycle`。共用 job 只为节省执行成本，这些测试并不因此成为另一类冒烟测试。

## 目录结构

每个场景目录存放测试入口和配套的 Node 脚本，共用的基础设施 fixture 保留在 `conftest.py`，仓库和测试目录路径统一定义在 `project_paths.py`。操作员编辑测试也使用 `memory-catalog/catalog-server.mjs`；生命周期测试复用 `input-bundle/publish-input.mjs`。

```text
system-tests/
├── conftest.py
├── project_paths.py
├── pytest.ini
├── review-runs-http/
├── execution-submission/
├── memory-catalog/
├── input-bundle/
├── memory-operator-edit/
└── execution-lifecycle/
```

## 前置条件

使用 `agents/.python-version` 指定的 Python 版本、参与测试的包所支持的 Node 和 pnpm 版本，并确保 Docker 守护进程正在运行。按 lockfile 安装依赖：

```bash
uv --project agents sync --group test --frozen
pnpm install --frozen-lockfile
```

只需安装和构建所选测试依赖的包。run 提交测试会自行构建所需的包；Python 测试使用已编译的 Node 模块，需要先执行下文的构建命令。

## Review Runs HTTP

这个测试会在本机启动 Review Runs HTTP 服务，再用编译后的 GitHub Integration 的 Review Runs 客户端发送请求。它检查客户端能否正确处理两种成功响应：正文为空的 HTTP 200 响应，以及包含 JSON 正文的响应。测试用模拟存储代替真实数据库，无需启动数据库或 Docker。

```bash
pnpm --dir apps/github-integration run build
pnpm --dir services/review-runs run build
node --test system-tests/review-runs-http/review-runs-http.test.mjs
```

## run 提交

run 提交系统测试覆盖提交边界。它构建 Review Runs 和 Execution Gateway，启动临时 Temporal 服务，并验证 Review Runs 的 Execution API 客户端能通过真实的 Execution Gateway HTTP 接口提交任务请求、重复提交相同请求，以及读取执行状态：

```bash
node --test system-tests/execution-submission/execution-submission.test.mjs
```

设置 `TEST_TEMPORAL_ADDRESS` 可使用已有的临时 Temporal 服务。否则，测试使用 `compose.yaml` 配置的 Temporal 镜像，并在结束后移除临时 Docker 容器。测试有意在 Worker 执行前停止；Worker 执行需要另外配置 Agent 运行时、工作区、对象存储和模型访问。

## 不调用模型的跨服务冒烟测试

以下命令运行清单中的 Catalog 客户端、输入包和 Memory 操作员编辑场景。

从仓库根目录运行：

```bash
pnpm --dir services/memory-catalog run build
pnpm --dir apps/github-integration run build
pnpm --dir apps/control-plane-ui exec tsc -p tsconfig.server.build.json
uv --project agents run python -m pytest system-tests/memory-catalog/test_memory_catalog.py system-tests/input-bundle/test_input_bundle.py system-tests/memory-operator-edit/test_memory_bff.py -q --durations=10
```

Docker 必须可用。fixture 使用 `compose.yaml` 中的镜像创建独立容器，随机分配宿主机端口，并在结束后移除自己创建的容器。这些探针不使用部署环境的数据库 URL 或对象存储凭据。同一次 pytest 调用中，选中的探针共享 PostgreSQL 和 RustFS；未使用的 fixture 不会启动服务。Node 服务绑定本机临时端口，并在每个测试结束后停止。

主 CI 通过 `.github/ci/changed-areas.yml` 中的路径规则，根据使用这些接口或数据的代码是否发生变更来选择测试，仅构建相关包，并将冒烟测试任务汇总到 CI Status。合并队列候选提交会运行冒烟探针。测试不调用模型、GitHub 或 Langfuse；BFF 探针使用 HTTP，不增加浏览器测试矩阵。

## 手动执行生命周期探针

`Smoke — Execution Lifecycle` 需要在 GitHub Actions 中手动运行，不属于 PR 合并前的必需检查。它使用 Review Runs 的 Execution API 客户端和持久存储、Execution Gateway HTTP、Temporal 执行与 Issue 工作流、Worker 输入准备、向 RustFS 发布诊断，以及将最终执行状态写回 PostgreSQL。随后重新打开存储，领取已持久化的发布结果。

测试中的安全分析任务使用预设结果，表示未发现需要处理的问题（`no-actionable-finding`）。它会在首次执行时故意失败，以检查工作流能否自动重试。修复和验证任务运行实际的阶段代码，但使用预设的模型输出，不修改代码。快照恢复、基线提交解析和结果持久化仍会执行。这验证的是工作流编排和产物传输，不验证模型质量、实际修复、GitHub 发布或 Memory 提取。

安装依赖并构建参与方后运行：

```bash
pnpm --dir apps/github-integration run build
pnpm --dir services/execution-gateway run build
pnpm --dir services/review-runs run build
uv --project agents run python -m pytest system-tests/execution-lifecycle/test_execution_lifecycle.py -q --durations=10
```

驱动程序直接调用 Review Runs 协调函数，不运行其 HTTP 接入接口和后台轮询调度器。PostgreSQL、Temporal 和 RustFS 使用真实的独立容器。服务就绪等待、子进程、测试和 CI job 均设有时间限制；可通过 stdout/stderr 和 pytest 耗时定位失败及缓慢的边界。

## 测试支持与隔离

- `conftest.py` 负责临时 PostgreSQL、RustFS 和 Temporal 容器、就绪探针及 Node 子进程清理。PostgreSQL 为 Catalog 和 Review Runs 使用独立数据库，避免数据库迁移记录冲突。
- `memory-catalog/catalog-server.mjs` 和 `memory-operator-edit/bff-server.mjs` 在本机临时端口上启动实际服务，开始监听后才写入 JSON 就绪文件；启动日志保存在 pytest 临时目录中。
- `input-bundle/publish-input.mjs` 创建固定工作区，然后调用实际的 TypeScript 函数生成清单、打包并发布。它发布两次以验证幂等性。
- `execution-lifecycle/execution-lifecycle.mjs` 驱动生产提交及观察函数，并检查重新打开存储后是否仍可领取发布结果。
- `pytest.ini` 限制单个测试的执行时间，并声明 `lifecycle` 标记。该标记用于标识涉及更多服务和执行步骤的测试；本地选择整个目录时也会运行生命周期测试。

fixture 在同一次 pytest 调用中共享基础设施，但每个测试使用独立身份。容器不使用部署卷或固定宿主机端口。正常清理仅移除测试创建的资源。如果测试进程被强制终止，先检查带有 `seam-` 前缀的容器，再清理残留资源。

## 成本与诊断

使用 `--durations=10` 区分准备、测试和清理阶段的成本。本地缓存运行不包含依赖安装或镜像拉取耗时，因此不能作为 CI 延迟保证。冒烟测试 action 编译所选测试依赖的包，并在单个进程中运行选中的测试，不增加浏览器、模型或操作系统矩阵。

失败时，检查 pytest 捕获的 Node 标准错误输出和测试临时目录中的 `node-*.log` 文件。就绪检查失败时会附带启动日志。生命周期测试的失败输出可能包含故意注入的首次分析异常；只有后续重试成功且对最终执行结果的检查通过时，该异常才属于预期行为。

## 维护这些测试

断言应关注可观察的传输、产物和持久化结果。优先使用小型测试数据和具体的失败/重试场景，避免宽泛的模型驱动用例。测试新增对数据生成服务或使用服务的依赖时，更新[变更区域模型](../.github/ci/changed-areas.yml)和[冒烟测试 action](../.github/actions/check-seams/action.yml)，确保相关测试与构建一起运行。

按照[脚本指南](../scripts/README.zh.md)中的说明，从 `scripts/` 运行脚本格式和 lint 检查，并运行受影响的系统测试。Node 辅助程序可用 `node --check` 检查；Python 测试使用 pytest 风格函数和普通断言。
