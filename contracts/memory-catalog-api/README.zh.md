# Memory Catalog API

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

[openapi.yaml](openapi.yaml) 是人工维护的 Memory Catalog Server HTTP 边界唯一真值，不由服务代码生成。服务从该文档挂载路由和校验，生成的 TypeScript 类型把 handler 绑定到 operation body，Python client 的契约测试则校验它发送和消费的 payload。

该契约刻意不包含 PostgreSQL row、Temporal workflow 状态、transcript 内容和对象存储凭据。

在 `tools/` 中生成并检查已提交的投影：

```bash
pnpm install
pnpm run generate
pnpm test
```
