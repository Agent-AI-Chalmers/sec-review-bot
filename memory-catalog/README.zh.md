# Memory Catalog

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

`memory-catalog/` 提供登记已完成 extraction、协调 observation 处理与提交 memory tree revision 的 HTTP API。协调状态保存在 PostgreSQL 中；worker 把不可变的 memory tree 和压缩后的 memory-agent transcript 发布到对象存储，catalog 保存对应的 artifact reference。

## API

| 方法   | 路径                               | 用途                                                                                          |
| ------ | ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET`  | `/healthz`                         | 返回服务健康状态。                                                                            |
| `POST` | `/v1/extractions`                  | 原子登记已完成 extraction、transcript reference 和可选 observation。                          |
| `GET`  | `/v1/extractions/{extraction_id}`  | 返回指定 extraction、transcript reference 和可选 observation。                                |
| `GET`  | `/v1/observations/pending-summary` | 返回 pending observations 的数量和最早等待时间。                                              |
| `POST` | `/v1/maintenance/batches/select`   | 基于 active revision 选择有界的 observation batch。                                           |
| `POST` | `/v1/maintenance/complete`         | 通过 compare-and-swap 提交新的 memory tree revision，并把来源 observations 标记为 processed。 |
| `GET`  | `/v1/active-revision`              | 返回 active revision 及其 memory tree reference。                                             |
| `GET`  | `/v1/revisions`                    | 列出 memory tree revision 历史。                                                              |
| `GET`  | `/v1/revisions/{revision}`         | 返回指定 revision 及其 maintenance transcript reference。                                     |

该服务独占自己的 PostgreSQL database 和 `schema_versions` ledger。默认集成部署将它与 Control Plane database 放在同一个 PostgreSQL 实例中，但两者是相互独立的 database。

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
