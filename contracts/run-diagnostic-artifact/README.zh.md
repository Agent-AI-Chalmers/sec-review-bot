# Run Diagnostic Artifact

语言：[English](README.md) | 中文

本 family 定义一个已完成 review run 所发布的 archive。它是共享 [tar-zstd-artifact v1 envelope](../tar-zstd-artifact/v1/SPEC.zh.md) 上的 profile，不属于 Execution API contract。

- [v1/SPEC.zh.md](v1/SPEC.zh.md) 定义内部目录树与 manifest 关系。
- Producer 与 consumer 行为由各 package 的 diagnostic bundle test 覆盖；共享 envelope corpus 由 `tar-zstd-artifact` 拥有。
