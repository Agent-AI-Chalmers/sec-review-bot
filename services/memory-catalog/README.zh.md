# Memory Catalog

语言：[English](README.md) | 中文

本文为 [README.md](README.md) 的中文译文；如有差异，以英文版为准。

Memory Catalog 提供 HTTP API，登记 extraction（一次已完成的经验提取记录）、管理待处理的 observation（经验提取的初步结果，供后续记忆维护筛选），并保存记忆树的修订历史和当前生效版本。

## API

| 方法   | 路径                                   | 用途                                                                                |
| ------ | -------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET`  | `/healthz`                             | 返回服务健康状态。                                                                  |
| `POST` | `/v1/extractions`                      | 登记 extraction、执行轨迹引用和可选 observation。                                   |
| `GET`  | `/v1/extractions`                      | 使用稳定游标分页和来源记录过滤列出已完成的 extraction。                             |
| `GET`  | `/v1/extractions/{extraction_id}`      | 返回指定 extraction、执行轨迹引用和可选 observation。                               |
| `GET`  | `/v1/overview`                         | 汇总已完成提取的单元覆盖、经验产出，以及 30 天、90 天或全部历史的趋势。             |
| `GET`  | `/v1/observations`                     | 使用稳定游标分页和消费状态过滤列出 observation。                                    |
| `GET`  | `/v1/observation-backlog`              | 返回待处理 observation 的数量和最早等待时间。                                       |
| `GET`  | `/v1/memory-tree/automation`           | 返回已保存的记忆树自动更新许可 `enabled` 或 `paused` 状态。                         |
| `POST` | `/v1/memory-tree/automation/pause`     | 按 operation ID 幂等处理，并通过控制版本 CAS 检查暂停记忆树自动提交。               |
| `POST` | `/v1/memory-tree/automation/resume`    | 按 operation ID 幂等处理，并通过控制版本 CAS 检查恢复记忆树自动提交。               |
| `GET`  | `/v1/learning-input?limit=...`         | 返回不超过 `limit` 条 observation，以及记忆维护 Agent 必须基于的当前生效记忆状态。  |
| `POST` | `/v1/memory-tree/revisions`            | 通过幂等身份和预期生效版本 CAS 检查，创建 learning、reorganization 或 manual 修订。 |
| `GET`  | `/v1/memory-tree`                      | 返回当前记忆文件树及其修订。                                                        |
| `POST` | `/v1/memory-tree/restore`              | 把当前生效版本指针移到已有修订，不创建修订。                                        |
| `GET`  | `/v1/memory-tree/revisions`            | 列出记忆文件树修订历史。                                                            |
| `GET`  | `/v1/memory-tree/revisions/{revision}` | 返回指定记忆文件树修订、维护任务身份和产物引用。                                    |

## 使用说明

### 数据存储与分页

该服务使用独立的 PostgreSQL 数据库，`schema_versions` 记录已执行的数据库结构版本。默认集成部署中，它与 Review Runs 共用 PostgreSQL 实例，但使用不同数据库。

extraction 和 observation 按 `created_at`、`extraction_id` 降序排列。调用方应使用服务返回的游标翻页，不解析游标内容；下一页不重复包含游标对应项。

### 修订与记忆树自动更新

修订通过 `learning`（吸收新 observation）、`reorganization`（整理现有记忆）或 `manual`（人工编辑）区分产生方式。`predecessor_revision` 记录创建时的生效版本；恢复旧版本只改变当前生效版本，不创建新修订，后续修订编号仍递增。人工编辑不消费待处理 observation。`learning` 和 `reorganization` 修订保存 maintainer 的 `maintenance_report`；如果报告没有对每个已消费提取恰好给出一条决定，或非 `skipped` 决定未列出修改的主题，服务会拒绝请求。

<!-- doc-default: memory-tree-automation-state; source=services/memory-catalog/src/database/schema-versions/001_initial_catalog.sql -->

记忆树自动更新支持 `enabled` 和 `paused`，初始状态为 `enabled`。该状态控制是否允许提交新的 `learning` 和 `reorganization` 修订，不代表 worker 的运行状态。暂停、恢复请求包含 `operation_id` 和 `expected_generation`；响应包含 `created` 和 `automation` 状态快照。暂停期间，这些提交返回 HTTP 409 和 `AUTOMATION_PAUSED`。暂停不会中止正在运行的任务，也不阻止 extraction 登记、产物发布、人工修订、恢复版本或成功提交的相同请求重放。

同一时间只允许一个记忆维护任务运行，由 Temporal 的固定 workflow ID 和 `SKIP` 重叠策略保证。

Worker 可通过 `POST /v1/memory-tree/revisions/publications/abandon` 放弃已有且未选定的自动修订 publication。对这些候选而言，`abandoned` 是终态：reserve 和 confirm 重试会保留该状态，commit 返回 HTTP 409 和 `PUBLICATION_ABANDONED`。自动提交遇到暂停时，会在同一事务中放弃该来源类型和 operation ID 下已有且未选定的 publication，然后返回 `AUTOMATION_PAUSED`。维护 workflow 在准备阶段发现暂停时也会放弃这些 publication，并退出，不再因 backlog 续跑。已选定的 publication 仍可重放；产物对象会保留。

### 发布与重试

发布 extraction 或记忆修订时，先记录包含完整结果和文件引用的发布意图，再上传文件、确认上传完成，最后登记结果。登记内容必须与已确认的发布意图一致。

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

Worker 凭据用于登记 extraction 和自动维护。Operator 凭据用于读取目录，以及控制台的暂停、编辑、恢复版本和恢复维护操作。服务端根据认证角色确定审计记录中的操作者。

## 检查

```bash
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run test:integration
```

`pnpm test` 运行隔离的单元测试和服务端测试。`pnpm run test:integration` 使用显式提供的 `TEST_DATABASE_URL` 对 PostgreSQL 存储实现进行测试；未设置时，启动脚本会使用仓库 `compose.yaml` 中配置的镜像创建并清理一个临时本地 Docker PostgreSQL 实例。启动脚本会有意忽略服务常规使用的 `MEMORY_CATALOG_DATABASE_URL`，避免测试意外修改共享数据库。

每次 extraction 可以产出零到多条 observation。`extraction_id` 标识调用及其来源；`observation_id` 标识可独立维护的经验。注册操作原子发布完整的 `observations` 数组；learning 消费 `observation_ids`，并为每条 observation 记录一个决定。

这是不兼容的 schema 和 API 变更。已有 Memory Catalog 数据库必须重建，worker 与服务端必须同步更新；旧的单 observation 请求和待处理 workflow payload 不受支持，不提供迁移或兼容适配层。

Observation ID 是全局唯一的不透明标识，API 不要求 extraction ID 前缀。另一条 extraction 使用已占用的 observation ID 时，返回 HTTP 409，并回滚整次注册。分页游标是不透明的，排序位置使用当前列表的行 ID。
