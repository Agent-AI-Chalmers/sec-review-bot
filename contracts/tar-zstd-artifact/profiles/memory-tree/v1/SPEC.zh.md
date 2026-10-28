# Memory Tree Artifact - v1

语言：[English](SPEC.md) | 中文

本文是 [SPEC.md](SPEC.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

## 封装

v1 memory tree artifact 使用受限 POSIX PAX [envelope v1](../../../envelope/v1/SPEC.zh.md)。

| 属性 | 必须值 |
| --- | --- |
| Media type | `application/tar+zstd` |
| 摘要 | 实际压缩归档字节的小写 `sha256` |
| 对象 key | `memory/trees/<hex>/memory-tree.v1.tar.zst`，其中 `<hex>` 是不带前缀的 64 字符摘要 |
| 最大压缩归档大小 | 64 MiB（`67,108,864` bytes） |
| 最大 entry 数量 | 10,000，包括文件和目录 |
| 最大 regular-file 总大小 | 256 MiB（`268,435,456` bytes） |
| 最大单个 regular-file 大小 | 16 MiB（`16,777,216` bytes） |

单文件限制有意低于两个总量限制。memory tree 中的 Markdown 文件受上述大小限制约束；单个文件不得耗尽压缩归档预算或主导解压内存。

消费者必须在解压前校验压缩字节大小和摘要，并在解析时执行 entry 数量与解压大小限制。在验证路径、类型、声明大小和元数据之前，不得提取 entry。

当 artifact 通过对象存储 reference 引用时，消费者还必须要求 URI 精确指向由声明 digest 派生的对象 key。仅匹配 bucket 或目录前缀并不充分：reference URI、digest 与压缩字节共同构成一个 identity。

## 必需目录树

归档只包含以下结构根：

```text
manifest.json
memory/
memory/MEMORY.md
memory/topics/
memory/topics/**/*.md  （可选）
```

`manifest.json` 是 UTF-8 JSON 文件，其字节必须精确为：

```json
{"version":1}
```

并以一个 LF byte 结尾。解析值必须符合 [manifest.schema.json](manifest.schema.json)：对象只包含值为 `1` 的整数 `version` 字段。

`memory/MEMORY.md` 与 `memory/topics/` 下的所有 regular file 必须是合法 UTF-8 Markdown。topic 文件必须以 `.md` 结尾。`memory/topics/` 下允许使用目录分组，但禁止空 path segment、`.`、`..`、绝对路径、反斜杠、NUL byte 与重复路径。路径使用 `/`，相对归档根，并采用规范形式：regular-file 路径不以斜杠结尾，目录路径恰好以一个斜杠结尾。

不允许其他路径。尤其是 `memory/` 下除 `MEMORY.md` 外的文件，以及 `memory/topics/` 下非 Markdown 文件，均无效。

## Entry 表示

entry 遵循 envelope 的 canonical type 与 metadata 规则。消费者必须直接分类 tar header 类型，绝不能跟随 link。

路径无法放入 ustar `name` 与 `prefix` 字段时，允许使用 envelope 的局部 PAX `path` header。其他 PAX 与 GNU extension 仍然无效。

## 顺序

`manifest.json` 必须是第一个 entry。其余 entry 按规范路径的 bytewise lexical 升序排列。必需父目录必须作为 entry 存在；除 lexical ordering 规则外，不额外要求父目录先于子项。

归档至少以两个全零 512-byte block 结束。tar terminator 后的字节只有全零 padding 才合法。

## 规范生产

生产者必须输出规定的 entry 集合、metadata、顺序与 JSON 字节；只有有效路径无法放入 ustar 字段时才使用局部 PAX `path` header；随后将 tar stream 压缩为一个 Zstandard frame。契约不固定 compressor 实现或压缩级别：artifact identity 是实际压缩字节的 SHA-256 摘要，对象 key 由该摘要派生。

消费者可接受任何符合标准且解压后 tar 满足本规范的 Zstandard frame。当 decoder 能识别拼接 frame 或尾随非 frame 数据时，必须拒绝这些输入。

生产者与消费者职责有意分开。生产者必须把 archive library 的输出约束在共享的受限 PAX 方言内。消费者必须校验实际存储的表示，包括高层 archive API 在投影 member 时可能隐藏的 extension header。

## 共享 Corpus

[corpus/manifest.json](corpus/manifest.json) 记录每个已提交 `.tar.zst` 用例的用途、逻辑 entry 数量、压缩字节 SHA-256 摘要、精确压缩大小与预期结果。普通用例包含有序的有效 entry 列表；大型压力用例可以省略重复列表，同时保留真实 archive 与聚合数量。corpus 包含合法 minimal、合法 topics、合法字节序和合法长路径 PAX tree，以及覆盖错误字节序、缺失 index、错误 manifest、路径穿越、symlink、意外路径、意外 entry 类型、不支持的 PAX metadata 和 entry 数量上限的非法归档。

corpus archive 由 `tools/src/generate.ts` 生成。contract tests 校验真实压缩字节和 archive 语义；文件名或 manifest 标签本身不能作为判定依据。
