# 任务诊断产物 — v1

语言：[English](SPEC.md) | 中文

本文为 [SPEC.md](SPEC.md) 的中文译文；如有差异，以英文版为准。

## Envelope

产物使用受限 POSIX PAX [envelope v1](../../../envelope/v1/SPEC.zh.md)，媒体类型为 `application/tar+zstd`，文件名为 `diagnostic-tree.v1.tar.zst`。

| 属性 | 限制 |
| --- | --- |
| 压缩归档大小 | 1 GiB（`1,073,741,824` 字节） |
| 条目数量 | 100,000，包含文件与目录 |
| 普通文件总大小 | 8 GiB（`8,589,934,592` 字节） |

## 目录树

归档包含 `manifest.json`、`result.json` 和 `artifact-tree/` 目录，后者保存该任务已持久化的诊断文件。只允许普通文件和目录。路径必须相对于归档根目录，使用 `/` 分隔，不能包含空片段、`.`、`..` 或反斜杠，也不能重复。

清单是 UTF-8 JSON 对象，包含 `version: 1`、所属 `run_id`、`result: "result.json"` 与 `review_units` 数组。每个审查单元包含唯一的字符串 `id` 和 `trajectories` 数组。轨迹路径遵循与归档条目相同的规范相对路径规则，指向 `artifact-tree/` 下的 `.jsonl` 文件，并且必须真实存在于归档中。

`result.json` 必须是合法 UTF-8 JSON。读取方可以根据用途设置更低的预览大小限制，但必须先完成 envelope 校验，再解析这两个 JSON 文件。

## 生产

生成方遵守 envelope 的条目规则，从 `artifact-tree/` 中排除发布目录和符号链接，在发布前检查本格式的资源限制，并明确选择 POSIX PAX 输出。生成完成后，按共享 envelope 和本格式校验归档，再发布。读取方在读取和提取文件时执行相同限制。

## 共享测试输入

[corpus/manifest.json](corpus/manifest.json) 记录真实的合法与非法诊断归档。所有读取方都必须测试这些实际字节，也必须执行共享 envelope 的测试输入。用例覆盖最小合法目录树、使用 PAX 的合法轨迹长路径、清单中的结果引用、轨迹缺失、轨迹路径不规范、轨迹文件名要求、审查单元标识重复，以及链接条目。
