# Tar+Zstandard Artifacts

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

本 family 定义项目自有、media type 为 `application/tar+zstd` 的 artifact 所共享的 archive envelope，以及规定每种 artifact 内部组织的 profiles。

- [envelope/v1/SPEC.zh.md](envelope/v1/SPEC.zh.md) 定义受限 POSIX PAX 方言。
- [envelope/v1/corpus](envelope/v1/corpus) 包含由所有 archive reader 共同执行的编码互操作与拒绝用例。
- [profiles/memory-tree](profiles/memory-tree/README.zh.md) 定义不可变 memory-tree archive。
- [profiles/input-bundle](profiles/input-bundle/README.zh.md) 定义已准备的 execution input archive。
- [profiles/run-diagnostic](profiles/run-diagnostic/README.zh.md) 定义 completed-run diagnostic archive。

Envelope 与 profile version 相互独立。每个 profile specification 都明确声明自己使用的 envelope version。

## 工具

从拥有对应层的目录运行其工具：

```bash
pnpm --dir contracts/tar-zstd-artifact/envelope/tools run check
pnpm --dir contracts/tar-zstd-artifact/profiles/memory-tree/tools run check
pnpm --dir contracts/tar-zstd-artifact/profiles/input-bundle/tools run check
pnpm --dir contracts/tar-zstd-artifact/profiles/run-diagnostic/tools run check
```
