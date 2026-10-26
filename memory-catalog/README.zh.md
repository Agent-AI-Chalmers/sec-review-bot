# Memory Catalog

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

`memory-catalog/` 提供登记已完成 extraction、协调 observation 处理与提交 memory tree revision 的 HTTP API。协调状态保存在 PostgreSQL 中；worker 把不可变的 memory tree 和压缩后的 memory-agent transcript 发布到对象存储，catalog 保存对应的 artifact reference。

## API

| 方法   | 路径                                   | 用途                                                                                      |
| ------ | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET`  | `/healthz`                             | 返回服务健康状态。                                                                        |
| `POST` | `/v1/extractions`                      | 原子登记已完成 extraction、transcript reference 和可选 observation。                      |
| `GET`  | `/v1/extractions/{extraction_id}`      | 返回指定 extraction、transcript reference 和可选 observation。                            |
| `GET`  | `/v1/observation-backlog`              | 返回 pending observations 的数量和最早等待时间。                                          |
| `GET`  | `/v1/maintenance-input?limit=...`      | 返回有界 observations，以及 maintainer 必须基于的 active memory 状态。                    |
| `POST` | `/v1/memory-tree/revisions`            | 通过 compare-and-swap 创建 memory tree revision，并把来源 observations 标记为 processed。 |
| `GET`  | `/v1/memory-tree`                      | 返回当前 memory tree 及其 revision。                                                      |
| `GET`  | `/v1/memory-tree/revisions`            | 列出 memory tree revision 历史。                                                          |
| `GET`  | `/v1/memory-tree/revisions/{revision}` | 返回指定 memory tree revision、maintenance identity 和 artifact references。              |

该服务独占自己的 PostgreSQL database 和 `schema_versions` ledger。默认集成部署将它与 Review Runs database 放在同一个 PostgreSQL 实例中，但两者是相互独立的 database。

任何时刻只允许一个 maintainer 执行。Temporal 使用固定 workflow ID 和 `SKIP` schedule overlap policy 强制该约束，因此 catalog 不实现 batch lease 或并发 claim。

Temporal 会先记录已发布的 artifact references，再调度 revision 提交 activity。因此提交重试会使用相同内容重复执行幂等 `POST`，而不会再次运行 maintainer。

## 本地运行

```bash
MEMORY_CATALOG_DATABASE_URL=postgresql://... \
MEMORY_CATALOG_TOKEN=... \
pnpm run server
```

## 检查

```bash
pnpm run lint
pnpm run typecheck
pnpm test
```
