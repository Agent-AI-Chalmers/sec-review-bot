# Memory Catalog

语言：[English](README.md) | 中文

本文为 [README.md](README.md) 的中文译文；如有差异，以英文版为准。

Memory Catalog 提供 HTTP API，记录经验提取结果（extraction）、管理待处理的经验条目（observation），并保存记忆树的修订历史和当前生效版本。

## API

| 方法   | 路径                                   | 用途                                                                                             |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET`  | `/healthz`                             | 返回服务健康状态。                                                                               |
| `POST` | `/v1/extractions`                      | 登记已完成的提取结果、执行轨迹引用和可选经验条目。                             |
| `GET`  | `/v1/extractions`                      | 使用稳定游标分页和来源记录过滤列出已完成提取记录。                                   |
| `GET`  | `/v1/extractions/{extraction_id}`      | 返回指定经验提取、执行轨迹引用和可选经验条目。                                   |
| `GET`  | `/v1/overview`                         | 汇总已完成提取的单元覆盖、经验产出，以及 30 天、90 天或全部历史的趋势。                   |
| `GET`  | `/v1/observations`                     | 使用稳定游标分页和消费状态过滤列出经验条目。                                            |
| `GET`  | `/v1/observation-backlog`              | 返回待处理经验条目的数量和最早等待时间。                                                 |
| `GET`  | `/v1/maintenance-control`              | 返回已保存的自动维护 `enabled` 或 `paused` 状态。                                          |
| `POST` | `/v1/maintenance-control/pause`        | 按 operation ID 幂等处理，并通过控制版本 CAS 检查暂停自动维护。                         |
| `POST` | `/v1/maintenance-control/resume`       | 按 operation ID 幂等处理，并通过控制版本 CAS 检查恢复自动维护。                         |
| `GET`  | `/v1/maintenance-input?limit=...`      | 返回不超过 `limit` 条经验条目，以及记忆维护 Agent 必须基于的当前生效记忆状态。              |
| `POST` | `/v1/memory-tree/revisions`            | 通过幂等身份和预期生效版本 CAS 检查，创建自动维护或人工修订。 |
| `GET`  | `/v1/memory-tree`                      | 返回当前记忆文件树及其修订。                                                             |
| `POST` | `/v1/memory-tree/restore`              | 把当前生效版本指针移到已有修订，不创建修订。                                           |
| `GET`  | `/v1/memory-tree/revisions`            | 列出记忆文件树修订历史。                                                                 |
| `GET`  | `/v1/memory-tree/revisions/{revision}` | 返回指定记忆文件树修订、维护任务身份和产物引用。                     |

## 使用说明

### 数据存储与分页

该服务使用独立的 PostgreSQL 数据库，`schema_versions` 记录已执行的数据库结构版本。默认集成部署中，它与 Review Runs 共用 PostgreSQL 实例，但使用不同数据库。

提取记录和经验条目按 `created_at`、`extraction_id` 降序排列。调用方应使用服务返回的游标翻页，不解析游标内容；下一页不重复包含游标对应项。

### 修订与自动维护

修订通过 `maintenance` 或 `operator` 区分自动维护和人工编辑。`predecessor_revision` 记录创建时的生效版本；恢复旧版本只改变当前生效版本，不创建新修订，后续修订编号仍递增。人工编辑不消费待处理经验条目。

自动维护支持 `enabled` 和 `paused`，初始状态为 `enabled`。暂停或恢复时，请求需提供 `operation_id` 和 `expected_generation`，防止重复操作和覆盖并发修改。暂停期间，自动维护提交返回 `MAINTENANCE_PAUSED`，人工修订不受影响。

同一时间只允许一个记忆维护任务运行，由 Temporal 的固定 workflow ID 和 `SKIP` 重叠策略保证。

### 发布与重试

发布提取结果或记忆修订时，先记录包含完整结果和文件引用的发布意图，再上传文件、确认上传完成，最后登记结果。登记内容必须与已确认的发布意图一致。

中断后，重试先检查已有发布意图和存储对象，再决定是否重新调用模型。无法访问存储不等于对象不存在；已经登记的结果所引用的对象丢失时，应报错，不能用新结果替换。

人工编辑重试沿用 operation ID 和最初预期的修订；相同内容返回原结果，改变内容则冲突。协议不会自动清理未引用对象，也不会在重试耗尽后自动完成发布。详细流程见 [SYSTEM_ARCHITECTURE](../../docs/architecture/SYSTEM_ARCHITECTURE.zh.md#artifact-发布与恢复)。

## 本地运行

数据库结构更新工具会核对已应用 SQL 的校验和。已有数据库中的 `001` 与仓库文件不一致时，必须显式升级或重建；只编辑 SQL 文件不会自动迁移现有数据库。

```bash
MEMORY_CATALOG_DATABASE_URL=postgresql://... \
MEMORY_CATALOG_WORKER_TOKEN=... \
MEMORY_CATALOG_OPERATOR_TOKEN=... \
pnpm run server
```

Worker 凭据用于登记提取结果和自动维护。Operator 凭据用于读取目录，以及控制台的暂停、编辑、恢复版本和恢复维护操作。服务端根据认证角色确定审计记录中的操作者。

## 检查

```bash
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run test:integration
```

`pnpm test` 运行隔离的单元测试和服务端测试。`pnpm run test:integration` 使用显式提供的 `TEST_DATABASE_URL` 对 PostgreSQL 存储实现进行测试；未设置时，启动脚本会使用仓库 `compose.yaml` 中配置的镜像创建并清理一个临时本地 Docker PostgreSQL 实例。启动脚本会有意忽略服务常规使用的 `MEMORY_CATALOG_DATABASE_URL`，避免测试意外修改共享数据库。
