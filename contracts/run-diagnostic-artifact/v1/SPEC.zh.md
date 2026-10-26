# Run Diagnostic Artifact - v1

语言：[English](SPEC.md) | 中文

## Envelope

artifact 使用受限 POSIX PAX [tar-zstd-artifact v1 envelope](../../tar-zstd-artifact/v1/SPEC.zh.md)，media type 为 `application/tar+zstd`，文件名为 `diagnostic-tree.v1.tar.zst`。

## 目录树

archive 包含 `manifest.json`、`result.json`，以及保存 run 持久化诊断文件的 `artifact-tree/` 目录。只允许 regular file 与 directory。路径必须相对 archive root、使用 `/`、不包含空 segment、`.`、`..` 或反斜杠。重复的有效路径无效。

manifest 是 UTF-8 JSON object，包含 `version: 1`、所属 `run_id`、`result: "result.json"` 与 `review_units` array。每个 review unit 包含唯一 string `id` 和 `transcripts` array；其中路径必须是 `artifact-tree/` 下的文件，并且必须真实存在于 archive 中。

`result.json` 必须是合法 UTF-8 JSON。消费者可以使用低于发布限制的角色专属 preview limit，但必须先执行 envelope 校验，再解释两个 JSON document。

## 生产

生产者规范化 `mtime`、`uid`、`gid`、`uname` 与 `gname`，从 `artifact-tree/` 排除 publication directory 和 symlink，显式选择 POSIX PAX 输出，并在发布前按共享 envelope 校验已完成 archive。
