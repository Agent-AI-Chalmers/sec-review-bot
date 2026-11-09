# Tar+Zstandard 产物

语言：[English](README.md) | 中文

本文为 [README.md](README.md) 的中文译文；如有差异，以英文版为准。

本目录定义媒体类型为 `application/tar+zstd` 的产物格式。envelope 规定各类产物共用的 Zstandard 压缩和 tar 格式；profile 规定其中的文件布局与内容要求。

- [SPEC](envelope/v1/SPEC.zh.md) 规定受限的 POSIX PAX 格式。
- [envelope/v1/corpus](envelope/v1/corpus) 保存各归档读取组件共用的真实归档测试输入，包括应接受和拒绝的格式。
- [profiles/memory-tree](profiles/memory-tree/README.zh.md) 规定不可变的记忆文件树归档。
- [profiles/input-bundle](profiles/input-bundle/README.zh.md) 规定已准备好的执行输入归档。
- [profiles/run-diagnostic](profiles/run-diagnostic/README.zh.md) 规定已结束任务的诊断归档。

envelope 和各 profile 分别维护版本。每份 profile 规范都会说明所用的 envelope 版本。

## 工具

在对应格式的工具目录中运行检查：

```bash
pnpm --dir contracts/tar-zstd-artifact/envelope/tools run check
pnpm --dir contracts/tar-zstd-artifact/profiles/memory-tree/tools run check
pnpm --dir contracts/tar-zstd-artifact/profiles/input-bundle/tools run check
pnpm --dir contracts/tar-zstd-artifact/profiles/run-diagnostic/tools run check
```
