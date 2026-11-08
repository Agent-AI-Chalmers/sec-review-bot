# 输入材料包产物 — v1

语言：[English](SPEC.md) | 中文

本文为 [SPEC.md](SPEC.md) 的中文译文；如有差异，以英文版为准。

## Envelope

v1 输入材料包使用受限 POSIX PAX [envelope v1](../../../envelope/v1/SPEC.zh.md)。

| 属性 | 必需值 |
| --- | --- |
| 媒体类型 | `application/tar+zstd` |
| 摘要 | 实际压缩归档字节的小写 `sha256` |
| 最大压缩归档大小 | 2 GiB（`2,147,483,648` 字节） |
| 最大条目数 | 100,000，包含文件与目录 |
| 普通文件总大小上限 | 8 GiB（`8,589,934,592` 字节） |

Execution API 的产物引用同时记录 URI、媒体类型、压缩字节数和摘要。存储位置由调用方的存储约定决定，本 profile 不作规定。

## 必需目录树

归档包含：

```text
manifest.json
workspace.snapshot.tar
history/
history/**                    （可选）
incremental-window/          （整体可选）
incremental-window/**        （可选）
```

`manifest.json` 必须是第一个条目，内容为符合 Execution API v1 `input-bundle-manifest.schema.json` 的 UTF-8 JSON。清单使用相对于材料包根目录的路径，指向 `workspace.snapshot.tar`、`history`，以及存在时的 `incremental-window`。

工作区快照以未压缩 tar 文件嵌套在外层传输归档中，执行阶段用它创建隔离工作区。本格式不解析快照内部内容；阶段还原工作区时，再按工作区快照的规则校验。

只允许普通文件和目录。路径必须是使用 `/` 分隔的相对 UTF-8 路径，不能包含空片段、`.`、`..`、绝对路径、反斜杠或 NUL 字节，也不能出现重复的实际路径。普通文件路径不以 `/` 结尾，目录路径恰好以一个 `/` 结尾。每个非根路径都必须有显式的父目录条目。

不允许上述目录树之外的路径。

## 顺序

`manifest.json` 位于首位。其余条目按规范 UTF-8 路径的字节字典序升序排列。只有实际路径无法放入普通 ustar 字段时，才使用 envelope 规定的局部 PAX `path` 扩展头。

## 生成与读取要求

生成方必须使用 envelope 规定的条目元数据和本格式规定的顺序，再将 tar 数据流压缩为单个 Zstandard 帧。契约不指定压缩器实现或压缩级别；产物以实际压缩字节的摘要标识。同一生成配置处理相同路径和文件内容时，重试必须生成相同的压缩字节。

读取方在解压前检查引用中的大小和摘要，在提取文件前检查共享 envelope 和本 profile，并在解析期间执行条目数及解压后字节数限制。不得提取路径不规范或超出规定目录树的条目。

## 共享测试输入

[corpus/manifest.json](corpus/manifest.json) 记录真实的合法与非法归档，覆盖最小目录树、增量目录树、条目顺序、必需路径、意外路径和符号链接。输入材料包的所有读取方都必须测试这些实际字节，也必须执行共享 envelope 的测试输入。
