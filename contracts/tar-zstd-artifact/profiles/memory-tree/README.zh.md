# Memory Tree Artifact

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

本 family 定义用于存储一棵已渲染 memory tree 的可移植、内容寻址归档。发布 tree 的生产者以及所有验证或解压该归档的服务共享此契约。

其压缩与 tar 表示遵循共享的 [envelope v1](../../envelope/v1/SPEC.zh.md)；本目录定义该 envelope 内部的 memory-tree profile。

## 契约

- [v1/SPEC.zh.md](v1/SPEC.zh.md) 定义归档布局、限制、规范 tar 元数据、压缩、摘要与对象 key。
- [v1/manifest.schema.json](v1/manifest.schema.json) 定义归档顶层 `manifest.json` 的精确 JSON 结构。
- [v1/corpus](v1/corpus) 包含真实压缩归档，以及记录每个用例目的、entry 数量、摘要、字节大小和预期验证结果的可读 manifest。普通用例还会列出有序 entry；大型压力用例可以只保留聚合 entry metadata。

## 所有权

artifact 生产者负责规范构造。每个消费者都必须在解压前执行完整归档边界校验；对象存储可信或摘要匹配，都不能使归档路径或 entry 类型自动安全。

## 工具

在 `tools/` 中运行：

```bash
pnpm run generate
pnpm run check
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm test
```

`generate` 写入共享 corpus archive 与 manifest。`check` 在临时目录中重新生成并逐 byte 比较。
