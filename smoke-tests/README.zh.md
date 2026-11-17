# 冒烟测试

Language: [English](README.md) | 中文

## 运行

安装 Docker Engine 和 Docker Compose 2.24.4 或更新版本，然后在仓库根目录运行：

```bash
bash smoke-tests/run.sh
```

脚本使用各服务的生产 Dockerfile 构建镜像，并为探针构建测试镜像。根目录的 [`compose.yaml`](../compose.yaml) 定义服务如何构建和连接；[`compose.test.yaml`](compose.test.yaml) 调整测试用的端口和数据卷，并加入探针容器。脚本合并这两个文件来启动服务，等服务就绪后执行检查。宿主机不用安装 Node 或 pnpm。

第一次运行可能需要下载依赖和基础设施镜像。Docker 会保留镜像和构建层，下次运行可以复用。

## 测什么

<!-- doc-default: smoke-tests.scenarios; source=smoke-tests/run.sh -->

冒烟测试通过公开的 HTTP、S3 和 Temporal CLI 接口执行以下检查：

| 场景               | 操作                                                                                                             | 预期结果                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 健康与认证         | 读取健康、就绪接口，分别带凭证和不带凭证访问受保护接口。                                                         | 服务和数据库就绪；带凭证的读取成功，无凭证请求被拒绝。                          |
| 重复创建任务       | 通过 Review Runs 两次创建同一任务。                                                                              | 两次请求返回同一任务，第二次不发放新的准备阶段 claim。                          |
| 输入包存储         | 使用生产 RustFS 初始化程序创建的身份，以 Integration 凭证上传、Execution 凭证下载，并尝试以 Execution 凭证写入。 | 字节、大小、媒体类型和 SHA-256 与共享归档一致；越权写入被拒绝。                 |
| 执行提交           | 登记已验证的 S3 引用，经 Review Runs → Execution Gateway → Temporal 提交任务。                                   | Gateway 返回 `running`，Review Runs 记录准备阶段已提交。                        |
| 提交重放与冲突     | 向 Gateway 重放相同提交，再使用同一 ID 提交不同输入，通过 CLI 比较 Temporal 执行 ID。                            | 相同提交成功，不同输入返回冲突，执行 ID 保持不变。                              |
| Gateway 重启       | 重启 Gateway，先查询原执行，再重复重放与冲突检查。                                                               | 原执行仍可读取，Temporal 执行 ID 保持不变。                                     |
| Review Runs 重启   | 停止 Review Runs，在其离线期间终止执行，然后重启 Review Runs。                                                   | 任务仍可读取并出现在列表中，Review Runs 经 Gateway 观察到失败终态。             |
| 控制台任务读取     | 登录正式 UI 服务，通过 BFF 读取已有任务。                                                                        | 带登录凭证的列表和详情返回真实任务及其失败执行状态。                            |
| 控制台 memory 读写 | 通过 UI BFF 创建 memory 版本、列出版本并读回文件内容。                                                           | Catalog 在 PostgreSQL 中提交版本，UI 使用自己的存储凭证从 RustFS 读回一致内容。 |

## 不测什么

存储探针上传、下载的是共享输入包 corpus 中的归档。测试队列没有 worker 领取任务，因此没有检查 worker 能否解包和使用这些文件。

测试不包含输入准备、agent 执行、模型调用和 GitHub 发布。控制台检查直接向正式 BFF 发送 HTTP 请求，不使用 Playwright，也不检查页面显示和浏览器操作。

## 隔离与清理

<!-- doc-default: smoke-tests.isolation; source=smoke-tests/run.sh -->

每次运行都有自己的 Compose 项目和命名数据卷。脚本使用固定测试凭证，不读取运维配置中的 `.env`，也不占用宿主机端口。

检查失败时，脚本打印容器状态和日志。退出时删除容器、网络和数据卷，保留镜像和构建缓存。

## 文件职责

| 文件                | 职责                                                            |
| ------------------- | --------------------------------------------------------------- |
| `run.sh`            | 设置环境、管理 Compose 生命周期、调用 Temporal CLI 和清理资源。 |
| `probe.ts`          | 解析命令行参数，运行对应的检查。                                |
| `review-runs.ts`    | 检查任务创建与重启恢复。                                        |
| `execution.ts`      | 检查提交、重放、冲突和 Temporal 执行身份。                      |
| `bff.ts`            | 通过 UI BFF 检查会话登录、任务读取和 memory 内容读写。          |
| `credentials.ts`    | 读取 Compose 传入的测试令牌，令牌值统一在 `run.sh` 定义。       |
| `http.ts`           | 提供共用 HTTP 请求逻辑和服务地址。                              |
| `storage-probe.ts`  | 使用公开 AWS SDK 检查 S3 传输和权限。                           |
| `Dockerfile`        | 编译 TypeScript 探针并提供运行环境。                            |
| `compose.test.yaml` | 定义测试覆盖配置和探针服务。                                    |

测试依赖写在此包中，版本由根目录 pnpm lockfile 锁定。生产服务不依赖这些探针。

## 开发检查

安装根工作区依赖，然后在 `smoke-tests/` 目录运行：

```bash
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run test:smoke
```

`test:smoke` 会构建并运行 Docker 容器。工作区默认测试命令不会运行它。
