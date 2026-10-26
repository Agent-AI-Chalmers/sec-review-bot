# Tar+Zstandard Artifact Envelope

语言：[English](README.md) | 中文

本 family 定义项目自有、media type 为 `application/tar+zstd` 的 artifact 所共享的 archive envelope。它不规定 artifact 的内部文件、manifest、限制或存储 key；这些规则仍由各 artifact profile 拥有。

- [v1/SPEC.zh.md](v1/SPEC.zh.md) 定义受限 POSIX PAX 方言。
- [v1/corpus](v1/corpus) 包含由所有 archive reader 共同执行的编码互操作与拒绝用例。

Memory-tree 与 run-diagnostic contract 都是此 envelope 之上的 profile。profile version 与 envelope version 相互独立。
