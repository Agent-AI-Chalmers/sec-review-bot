# Memory Catalog

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

`memory-catalog/` 提供登记已完成 extraction、协调 observation 处理与提交 memory tree revision 的 HTTP API。协调状态保存在 PostgreSQL 中；worker 把不可变的 memory tree 和压缩后的 memory-agent trajectory 发布到对象存储，catalog 保存对应的 artifact reference。

## API

| 方法   | 路径                                   | 用途                                                                                             |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET`  | `/healthz`                             | 返回服务健康状态。                                                                               |
| `POST` | `/v1/extractions`                      | 原子登记已完成 extraction、trajectory reference 和可选 observation。                             |
| `GET`  | `/v1/extractions`                      | 使用稳定 cursor 分页和 provenance 过滤列出已完成 extractions。                                   |
| `GET`  | `/v1/extractions/{extraction_id}`      | 返回指定 extraction、trajectory reference 和可选 observation。                                   |
| `GET`  | `/v1/overview`                         | 返回已完成 extraction 的单元覆盖、observation 产出、可选范围趋势和工作流汇总。                   |
| `GET`  | `/v1/observations`                     | 使用稳定 cursor 分页和消费状态过滤列出 observations。                                            |
| `GET`  | `/v1/observation-backlog`              | 返回 pending observations 的数量和最早等待时间。                                                 |
| `GET`  | `/v1/maintenance-control`              | 返回持久的自动 maintenance `enabled` 或 `paused` 状态。                                          |
| `POST` | `/v1/maintenance-control/pause`        | 使用 operation 幂等与 generation compare-and-swap 暂停自动 maintenance。                         |
| `POST` | `/v1/maintenance-control/resume`       | 使用 operation 幂等与 generation compare-and-swap 恢复自动 maintenance。                         |
| `GET`  | `/v1/maintenance-input?limit=...`      | 返回不超过 `limit` 条 observations，以及 maintainer 必须基于的 active memory 状态。              |
| `POST` | `/v1/memory-tree/revisions`            | 通过幂等身份和 expected-active-revision compare-and-swap 创建 maintenance 或 operator revision。 |
| `GET`  | `/v1/memory-tree`                      | 返回当前 memory tree 及其 revision。                                                             |
| `POST` | `/v1/memory-tree/restore`              | 把 active pointer 移到已有 revision，不创建 revision。                                           |
| `GET`  | `/v1/memory-tree/revisions`            | 列出 memory tree revision 历史。                                                                 |
| `GET`  | `/v1/memory-tree/revisions/{revision}` | 返回指定 memory tree revision、maintenance identity 和 artifact references。                     |

该服务独占自己的 PostgreSQL database 和 `schema_versions` ledger。默认集成部署将它与 Review Runs database 放在同一个 PostgreSQL 实例中，但两者是相互独立的 database。

列表 cursor 是不透明且排他的。Extractions 和 observations 均按 `created_at`、`extraction_id` 降序排列，因此相同时间戳的记录也能稳定翻页。Maintenance-control 单例是持久状态，初始值为 generation `0` 的 `enabled`；API 返回其当前状态，并通过 pause 与 resume operation 修改它。

任何时刻只允许一个 maintainer 执行。Temporal 使用固定 workflow ID 和 `SKIP` schedule overlap policy 强制该约束，因此 catalog 不实现 batch lease 或并发 claim。

Temporal 会先记录已发布的 artifact references，再调度 revision 提交 activity。因此提交重试会使用相同内容重复执行幂等 `POST`，而不会再次运行 maintainer。

Revision provenance 使用带标签的 maintenance/operator source。每个 revision 通过 `predecessor_revision` 记录创建时的 active revision；即使 active pointer 回退，revision 编号仍保持全局递增。Operator `operation_id` 全局唯一：相同内容重放返回原 revision，不同内容则冲突。Operator edit 不消费 observations。Restore 使用独立的幂等 ledger，只移动 active pointer；下一次自动或人工 revision 会把恢复后的 revision 记录为前驱。

Pause 与 resume 使用独立的幂等 ledger。相同重放会在检查当前 generation 前返回该 operation 保存的结果；新 operation 锁定 control 单例，检查 `expected_generation` 与合法转换后增加 generation。新的 maintenance revision 在提交事务中锁定同一行，并在 paused 时以 `MAINTENANCE_PAUSED` 冲突码被拒绝，与 revision compare-and-swap 冲突区分；operator revision 不受影响。Worker 的开始前读取只用于避免无效工作，不能替代该事务边界。

## 本地运行

```bash
MEMORY_CATALOG_DATABASE_URL=postgresql://... \
MEMORY_CATALOG_WORKER_TOKEN=... \
MEMORY_CATALOG_OPERATOR_TOKEN=... \
pnpm run server
```

Worker 凭据用于注册 extraction 和执行自动 maintenance。Operator 凭据用于 catalog 读取，以及 Control Plane UI 的 pause、edit、restore 和 resume 操作。服务端根据已认证角色生成 operator 审计 actor。

## 检查

```bash
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run test:integration
```

`pnpm test` 运行隔离的单元测试和 server 测试。`pnpm run test:integration` 使用显式提供的 `TEST_DATABASE_URL` 对 PostgreSQL store 进行测试；未设置时，launcher 会使用仓库 `compose.yaml` 中配置的镜像创建并清理一个临时本地 Docker PostgreSQL 实例。Launcher 会有意忽略服务常规使用的 `MEMORY_CATALOG_DATABASE_URL`，避免测试意外修改共享数据库。
