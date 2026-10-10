# 集成契约

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

本族描述 Runner 与其调用方之间受支持的公开集成点。它分为两层：

1. 生产传输层：HTTP Agent Runner Service。
2. 数据契约：runner 输入、workflow 结果、`ReviewRecord` 和 repository `deliveries[]`。

从这些文档开始：

- [RUNNER_HTTP_API.zh.md](RUNNER_HTTP_API.zh.md)：调用方如何创建和轮询 workflow run。
- [v5/CONTRACT.zh.md](v5/CONTRACT.zh.md)：workflow 输入和结果结构。
- [v5/schemas](v5/schemas)：用于机器校验的 JSON Schema。
- [v5/fixtures](v5/fixtures)：Python 和 TypeScript 测试共享的可执行 JSON 示例。

HTTP API 和 workflow 契约是稳定的公开接口。

## 公开边界

调用方可以依赖：

- runner HTTP API；
- HTTP API 接受的公开 workflow 名称；
- 当前 `contract_version` 的 runner 输入和公开 workflow 结果结构；
- 结构化 runner 成功和错误响应体。

以下内容不是稳定的公开 API：

- `agents` 下的内部 Python 模块路径；
- Temporal workflow 名称或 workflow/stage 实现细节；
- 诊断用 stage 产物结构，除非明确文档化为契约字段；
- GitHub integration 内部编排细节；
- 仅由发布策略或本地工具使用的非契约字段。

## 归属

调用方负责：

- 物化 input bundle；
- 通过 HTTP 传输层调用 workflow；
- 消费结构化的结果与错误响应；
- 决定如何渲染或发布结果；
- 处理平台特有的发布规则，例如 GitHub PR 去重。

Agents 负责：

- 为 issue、pull request 和 repository workflow 执行结构化编排；
- 产出以 `review_record` 和 repository `deliveries[]` 为核心的结构化 workflow 结果；
- 保存 stage 产物。

GitHub integration 是调用方一侧的一种实现：它把 GitHub 事件与发布规则转成 runner 输入和结果发布。

这条分界同时也是安全边界。GitHub 身份、权限、API 调用、发布、重试与审计行为都留在调用方一侧。Agents 在 runner 契约内运行，不直接控制 GitHub 平台能力。

## 执行方式

Schema 文件是规范的可执行结构形式。当前版本使用 [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)。Python Runner 使用 [jsonschema](https://python-jsonschema.readthedocs.io/) 校验输入与结果 schema，TypeScript integration 独立使用 [Ajv](https://ajv.js.org/) 校验。两个包在测试中都会执行共享 fixture。

agents wheel 会在构建时把权威 schema 复制为包数据，因此安装后的 Python 工具在运行时不依赖仓库级 `contracts/` 路径。

> 可移植 JSON Schema 无法表达的跨字段不变量（例如 repository incremental 的 `base_sha != head_sha`）由运行时输入校验执行。平台发布策略（例如某个通过 schema 校验的路径是否可以发布到敏感的 GitHub 位置）留在调用方一侧。

运行时解析器还可以执行 schema 有意留作结构性的规范形式，例如枚举归一化、不支持的公开字段，以及可发布的 repository 路径策略。请把这些解析器检查视为各消费者运行时边界的一部分，而不是替代 schema 定义。

## 产物边界

除非某个字段明确提升进公开 workflow 结果，否则 stage 产物属于运行时诊断。公开结果包括 `review_record`、repository `case_results[]`、repository `deliveries[]`，以及 [v5/CONTRACT.zh.md](v5/CONTRACT.zh.md) 中记录的其他字段。

调用方应当从 workflow 结果发布，而不是读取整个 stage 产物包。如果某个 stage 产物成为调用方行为的必需项，要么把所需字段提升进本契约，要么把该依赖保留在本地调试工具内部。
