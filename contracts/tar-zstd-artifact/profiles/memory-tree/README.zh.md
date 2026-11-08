# 记忆文件树产物

语言：[English](README.md) | 中文

本文为 [README.md](README.md) 的中文译文；如有差异，以英文版为准。

本目录定义保存一份记忆文件树的归档格式。该格式可在不同组件间传递，并按内容寻址；发布、校验和解压记忆归档的组件都遵守同一份约定。

压缩方式和 tar 编码遵循共享 [envelope v1](../../envelope/v1/SPEC.zh.md)，本目录进一步规定 envelope 内部的记忆文件树格式。

## 规范与测试数据

- [SPEC](v1/SPEC.zh.md) 规定归档布局、大小限制、tar 元数据、压缩方式、摘要和对象键。
- [v1/manifest.schema.json](v1/manifest.schema.json) 规定归档顶层 `manifest.json` 的 JSON 结构。
- [v1/corpus](v1/corpus) 保存真实压缩归档和清单。清单记录用例目的、条目数量、摘要、字节数和预期校验结果。普通用例列出全部条目及顺序；大型压力用例可以只保留汇总信息。

## 生成与读取要求

生成方负责按规范构造归档。读取方在解压前必须完成全部格式检查；对象存储可信或摘要匹配，不代表路径和条目类型一定安全。

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

`generate` 写入共享测试归档和清单。`check` 在临时目录重新生成，并逐字节比较结果。
