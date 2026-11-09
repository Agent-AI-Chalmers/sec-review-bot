# 输入材料包产物

语言：[English](README.md) | 中文

本文为 [README.md](README.md) 的中文译文；如有差异，以英文版为准。

本目录定义不可变的输入材料包归档，用于将 Execution API 调用方准备好的审查输入传给 Execution Worker。它是在共享 [envelope v1](../../envelope/v1/SPEC.zh.md) 之上定义的 profile。

- [SPEC](v1/SPEC.zh.md) 规定目录树、生成要求和资源限制。
- [v1/corpus](v1/corpus) 保存真实归档；输入材料包的所有读取组件都必须测试这些输入，也必须执行共享 envelope 的测试输入。

产物引用对象和各工作流的清单 schema 由 Execution API 规定。本规范只定义归档的编码方式和目录范围，不规定输入准备的重试方式，也不规定对象存储的保留与清理策略。

## 工具

```bash
pnpm run generate
pnpm run check
pnpm run format:check
pnpm run lint
pnpm run test
```

从 `contracts/tar-zstd-artifact/profiles/input-bundle/tools/` 运行这些命令。
