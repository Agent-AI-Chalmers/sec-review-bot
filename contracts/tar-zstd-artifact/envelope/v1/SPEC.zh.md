# Tar+Zstandard Artifact Envelope - v1

语言：[English](SPEC.md) | 中文

本文是 [SPEC.md](SPEC.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

## 范围

本 contract 只定义项目自有 `application/tar+zstd` artifact 共享的表示。各 profile 自行定义允许的目录树、语义 metadata、规范顺序、资源限制和生产规则。

## 压缩

payload 是一个包含单个 tar archive 的 Zstandard frame。profile 可以规定更严格的压缩与解压大小限制。消费者必须拒绝错误压缩；当 decoder 能区分时，还必须拒绝拼接 frame 或尾随的非 frame 数据。

## 受限 POSIX PAX 方言

tar stream 使用 POSIX ustar header，并允许在被修改 member 前紧邻一个局部 PAX extended header（`typeflag` 为 `x`）。能直接由 ustar 表达的 member 不需要 extended header，仍属于本 PAX 方言。

支持的 PAX 子集有意保持精简：

- 局部 extended header 恰好包含一条 key 为 `path` 的 record；
- 单个局部 extended header 最大为 1 MiB；
- record length 必须精确，record 以 LF 结尾，value 必须是合法 UTF-8；
- `path` value 覆盖下一个 member 的 ustar name 与 prefix 字段；
- 连续或悬空的局部 extended header 无效；
- 禁止全局 PAX header（`g`）、未知 PAX key、重复 `path` record、GNU long-name（`L`）、GNU long-link（`K`）和 GNU sparse（`S`）extension。

消费者必须校验应用 `path` 后的有效路径；底层 ustar member 的占位名称不具权威。

## Canonical Entry

只允许 regular file 和 directory。每个 entry 使用 canonical metadata：

| Field | Regular file | Directory |
| --- | --- | --- |
| `mtime` | `0` | `0` |
| `uid`, `gid` | `0`, `0` | `0`, `0` |
| `uname`, `gname` | empty | empty |
| mode | `0644` | `0755` |
| size | 实际 body length | `0` |

profile 负责规定允许的 file 与 directory，但不能放宽这些共享 entry 规则。

## Tar 结构

每个 header 都必须有合法 checksum 与 POSIX ustar magic。entry body 补齐到 512-byte block。archive 至少以两个全零 block 结束，之后只允许全零 padding。

## 生产者规则

有效路径能放入普通 ustar 字段时，生产者使用普通字段；只有确有必要时才输出局部 `path` header。不得输出可选 timestamp、ownership key、实现私有 key 或冗余 PAX metadata。

## 共享 Corpus

[corpus/manifest.json](corpus/manifest.json) 标识真实 `.tar.zst` byte stream；每个消费者都必须在 envelope boundary 接受或拒绝相应样本。各 profile 的 corpus 另行覆盖内部布局与语义规则。
