# Run Diagnostic Artifact - v1

语言：[English](SPEC.md) | 中文

本文是 [SPEC.md](SPEC.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

## Envelope

artifact 使用受限 POSIX PAX [envelope v1](../../../envelope/v1/SPEC.zh.md)，media type 为 `application/tar+zstd`，文件名为 `diagnostic-tree.v1.tar.zst`。

## 目录树

archive 包含 `manifest.json`、`result.json`，以及保存 run 持久化诊断文件的 `artifact-tree/` 目录。只允许 regular file 与 directory。路径必须相对 archive root、使用 `/`、不包含空 segment、`.`、`..` 或反斜杠。重复的有效路径无效。

manifest 是 UTF-8 JSON object，包含 `version: 1`、所属 `run_id`、`result: "result.json"` 与 `review_units` array。每个 review unit 包含唯一 string `id` 和 `trajectories` array。Trajectory path 遵循与 archive entry 相同的规范相对路径规则，指向 `artifact-tree/` 下的 `.jsonl` 文件，并且必须真实存在于 archive 中。

`result.json` 必须是合法 UTF-8 JSON。消费者可以使用低于发布限制的角色专属 preview limit，但必须先执行 envelope 校验，再解释两个 JSON document。

## 生产

生产者应用 envelope 的 canonical entry 规则，从 `artifact-tree/` 排除 publication directory 和 symlink，显式选择 POSIX PAX 输出，并在发布前按共享 envelope 与本 profile 校验已完成 archive。

## 共享 Corpus

[corpus/manifest.json](corpus/manifest.json) 记录真实的合法与非法 run-diagnostic archive。每个消费者除了 envelope corpus 外，还必须执行这些 bytes。用例覆盖最小合法 tree、由 PAX 承载的合法 trajectory 长路径、manifest result reference、缺失 trajectory、非规范 trajectory path、trajectory filename 要求、重复 review-unit identity 与 link entry。
