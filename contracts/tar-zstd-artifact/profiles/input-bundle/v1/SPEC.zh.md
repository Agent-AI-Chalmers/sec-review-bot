# Input Bundle Artifact - v1

[English](SPEC.md) | 中文

## Envelope

v1 input bundle 使用受限 POSIX PAX [envelope v1](../../../envelope/v1/SPEC.zh.md)。

| 属性 | 必需值 |
| --- | --- |
| Media type | `application/tar+zstd` |
| Digest | 实际压缩 archive bytes 的小写 `sha256` |
| 最大压缩 archive 大小 | 2 GiB（`2,147,483,648` bytes） |
| 最大 entry 数 | 100,000，包含文件与目录 |
| regular-file 总大小上限 | 8 GiB（`8,589,934,592` bytes） |

Execution API reference 绑定 URI、media type、压缩 byte size 与 digest。存储位置由 caller 的 storage contract 拥有，不属于本 archive profile。

## Required Tree

Archive 包含：

```text
manifest.json
workspace.snapshot.tar
history/
history/**                    （可选）
incremental-window/          （整体可选）
incremental-window/**        （可选）
```

`manifest.json` 是第一个 entry，并且是符合 Execution API v1 `input-bundle-manifest.schema.json` 的 UTF-8 JSON document。它通过 bundle-relative path 指向 `workspace.snapshot.tar`、`history`，以及存在时的 `incremental-window`。

Workspace snapshot 有意作为未压缩 tar 嵌套在 transport archive 中。Execution stage 使用它创建隔离 workspace。本 profile 将其 bytes 视为 opaque；stage materialize 时再执行 workspace snapshot contract。

只允许 regular file 与 directory。Path 是使用 `/` 的相对 UTF-8 path。禁止空 segment、`.`、`..`、absolute path、backslash、NUL byte 与重复 effective path。Regular-file path 不以 `/` 结尾；directory path 恰好以一个 `/` 结尾。每个非 root path 都必须有显式 parent-directory entry。

不允许上述 tree 之外的 path。

## Entry Metadata And Ordering

每个 entry 使用 canonical metadata：

| Field | Regular file | Directory |
| --- | --- | --- |
| `mtime` | `0` | `0` |
| `uid`, `gid` | `0`, `0` | `0`, `0` |
| `uname`, `gname` | empty | empty |
| mode | `0644` | `0755` |
| size | 实际 byte length | `0` |

`manifest.json` 位于首位。其余 entry 按 canonical UTF-8 path 的 bytewise lexical order 升序排列。只有 effective path 无法放入普通 ustar field 时，才使用 envelope 的 local PAX `path` header。

## Production And Consumption

Producer 精确生成规定的 metadata 与顺序，然后将 tar stream 压缩为单个 Zstandard frame。本 contract 不固定 compressor implementation 或 compression level：artifact identity 是实际压缩 bytes 的 digest。对于相同 entry path 与 body，同一个 producer configuration 必须在重试间复现相同压缩 bytes。

Consumer 在解压前校验 reference size 与 digest，在 extraction 前校验共享 envelope 与本 profile，并在解析时执行 entry-count 与 extracted-byte limit。不得解压 link、special entry、non-canonical path 或 metadata 不符合本 profile 的 entry。

## Shared Corpus

[corpus/manifest.json](corpus/manifest.json) 记录真实的合法与非法 archive。用例覆盖 minimal 与 incremental tree、canonical ordering 和 metadata、required path、unexpected path 与 symbolic link。每个 input-bundle consumer 除 envelope corpus 外还必须执行这些 bytes。
