# Execution API

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

本族定义完整的公开 Execution API：HTTP 操作、execution 输入、workflow 结果、错误、`ReviewRecord` 和 repository `deliveries[]`。一个版本覆盖这整个接口；传输层与 payload schema 不再分别使用不同版本。

从这些文档开始：

- [v1/openapi.yaml](v1/openapi.yaml)：调用方如何创建和轮询 workflow run —— 路径、状态码、请求与响应形状、以及鉴权方案。
- [v1/CONTRACT.zh.md](v1/CONTRACT.zh.md)：workflow 输入和结果结构。
- [v1/schemas](v1/schemas)：用于机器校验的 JSON Schema。
- [v1/fixtures](v1/fixtures)：Python 和 TypeScript 测试共享的可执行 JSON 示例。

这些文件共同定义 Execution API v1。

## 公开边界

调用方可以依赖：

- Execution API；
- HTTP API 接受的公开 workflow 名称；
- 当前 `api_version` 的 execution 输入和公开 workflow 结果结构；
- 结构化 Execution API 成功和错误响应体。

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

GitHub integration 是调用方一侧的一种实现：它把 GitHub 事件与发布规则转成 execution 输入和结果发布。

这条分界同时也是安全边界。GitHub 身份、权限、API 调用、发布、重试与审计行为都留在调用方一侧。Execution Worker 在 execution 契约内运行，不直接控制 GitHub 平台能力。

## 唯一真值

[v1/openapi.yaml](v1/openapi.yaml) 定义 HTTP 操作与 envelope，同一版本目录中的 JSON Schema 定义 envelope 携带的 workflow 对象。它们作为一个 API 版本共同维护和发布，不由服务代码生成。Execution Gateway 从这些文件挂载路由和校验，contract tools 也从中生成 provider 与 consumer 类型。

生成的 TypeScript 投影会把 HTTP envelope 与 v1 workflow input schema 组合起来，使 provider 在编译期拥有 `workflow` 到 `input` 的对应关系，同时不引入共享运行时 package。

## 工具

在 `tools/` 中运行：

```bash
pnpm run generate
pnpm run check
pnpm run format:check
pnpm run lint
pnpm run lint:contract
pnpm run typecheck
pnpm test
```

## Execution 错误码

以下是调用方可以据以分支的稳定机器可读错误码。这个集合是**开放**的：服务暂时无法归类的失败会以 `EXECUTION_FAILED` 到达，而新增含义时会新增错误码，而不是复用旧码。

- `EXECUTION_REQUEST_INVALID`
- `EXECUTION_WORKFLOW_UNSUPPORTED`
- `EXECUTION_RUN_CONFLICT`
- `EXECUTION_RUN_NOT_FOUND`
- `EXECUTION_RESPONSE_INVALID`
- `EXECUTION_FAILED`

## 兼容性规则

以下变化属于破坏性变更：

- HTTP path / method 变化
- 某个结果所对应的状态码，或它携带的响应体形状
- request / response 必需字段变化
- error body 必需字段变化
- workflow 名称与 input 必需字段变化

新增端点、端点选项、或可选的请求/响应字段，属于非破坏性扩展。

## 执行方式

Schema 文件是规范的可执行结构形式。当前版本使用 [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)。Python Execution 使用 [jsonschema](https://python-jsonschema.readthedocs.io/) 校验输入与结果 schema，TypeScript integration 独立使用 [Ajv](https://ajv.js.org/) 校验。两个包在测试中都会执行共享 fixture。

agents wheel 会在构建时把权威 schema 复制为包数据，因此安装后的 Python 工具在运行时不依赖仓库级 `contracts/` 路径。

> 可移植 JSON Schema 无法表达的跨字段不变量（例如 repository incremental 的 `base_sha != head_sha`）由运行时输入校验执行。平台发布策略（例如某个通过 schema 校验的路径是否可以发布到敏感的 GitHub 位置）留在调用方一侧。

运行时解析器还可以执行 schema 有意留作结构性的规范形式，例如枚举归一化、不支持的公开字段，以及可发布的 repository 路径策略。请把这些解析器检查视为各消费者运行时边界的一部分，而不是替代 schema 定义。

## 产物边界

除非某个字段明确提升进公开 workflow 结果，否则 stage 产物属于运行时诊断。公开结果包括 `review_record`、repository `case_results[]`、repository `deliveries[]`，以及 [v1/CONTRACT.zh.md](v1/CONTRACT.zh.md) 中记录的其他字段。

调用方应当从 workflow 结果发布，而不是读取整个 stage 产物包。如果某个 stage 产物成为调用方行为的必需项，要么把所需字段提升进本契约，要么把该依赖保留在本地调试工具内部。
