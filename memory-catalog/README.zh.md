# Memory Catalog

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

`memory-catalog/` 是 Sec Review Bot 中可独立部署的 TypeScript managed-memory 数据边界。

它负责 PostgreSQL catalog、observation 登记、不可变 memory revision 历史、active revision 指针，以及基于 compare-and-swap 的 maintenance 提交。它不运行 agent、不读取 transcript、不访问对象存储，也不轮询 Temporal task queue。

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
