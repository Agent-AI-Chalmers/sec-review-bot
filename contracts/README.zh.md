# 契约

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

本目录是项目自有契约的工作区级根目录。

它同时包含人类可读的契约文档，以及跨包共享的可执行契约资产。

## 从这里开始

受支持的公开集成入口分成两层：

1. 生产传输层：HTTP Agent Runner Service。
2. 数据契约：runner 输入、workflow 结果、`ReviewRecord` 和 repository `deliveries[]`。

从这些文档开始：

- [RUNNER_HTTP_API.zh.md](RUNNER_HTTP_API.zh.md)：调用方如何创建和轮询 workflow run。
- [CONTRACT_V4.zh.md](CONTRACT_V4.zh.md)：workflow 输入和结果结构。
- [schemas/v4](schemas/v4)：用于机器校验的 JSON Schema。
- [fixtures/v4](fixtures/v4)：Python 和 TypeScript 测试共享的可执行 JSON 示例。

HTTP API 和 workflow 契约是稳定的公开接口。

## 公开边界

调用方可以依赖：

- runner HTTP API；
- HTTP API 接受的公开 workflow 名称；
- 当前 `contract_version` 的 runner 输入和公开 workflow 结果结构；
- 结构化 runner 成功和错误响应。

以下内容不是稳定的公开 API：

- `agents` 下的内部 Python 模块路径；
- Temporal workflow 名称或 workflow/stage 实现细节；
- 诊断用 stage 产物结构，除非明确文档化为契约字段；
- GitHub integration 内部编排细节；
- 仅发布策略或本地工具使用的非契约字段。

## 职责

调用方负责：

- 准备 input bundle；
- 通过 HTTP 传输层调用 workflow；
- 消费结构化结果和错误响应；
- 决定如何渲染或发布结果；
- 处理平台特有发布规则，例如 GitHub PR 去重。

Agents 负责：

- 执行 issue、pull request 和 repository workflow 的结构化流程；
- 产出以 `review_record` 和 repository `deliveries[]` 为中心的结构化 workflow 结果；
- 保存 stage 产物。

GitHub integration 是调用方侧的一种实现：它把 GitHub event 和发布规则转成 runner 输入，并负责结果发布。

这条职责划分同时也是安全边界。GitHub 身份、权限、API 调用、发布、重试和审计行为都留在调用方侧。Agents 在 runner 契约内工作，不直接控制 GitHub 平台能力。

## 规范、Schemas 和 Fixtures

Markdown 规范定义字段语义、兼容规则和集成指导。

Schema 文件是该规范的可执行结构化形式。契约 v4 schemas 使用 [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)。Python 测试使用 [jsonschema](https://python-jsonschema.readthedocs.io/) 校验，TypeScript 测试使用 [Ajv](https://ajv.js.org/) 校验。

Schemas 是结构性契约检查，不是所有运行时规则或发布规则的完整权威。

> 可移植 JSON Schema 无法表达的跨字段不变量，例如 repository incremental 的 `base_sha != head_sha`，由运行时输入校验处理。平台发布策略，例如某个符合 schema 的文件路径是否允许发布到 GitHub 敏感位置，则留给调用方处理。

运行时 parser 也可能强制 schema 有意保持结构化的规范形式，例如枚举规范化、禁止未支持的公开字段，以及可发布仓库路径策略。这些 parser 检查属于各消费方的运行时边界，不替代 schema 定义。

Fixture 文件提供测试可执行的具体 JSON 示例，因此也属于契约校验范围。

[`fixtures/v4/manifest.json`](fixtures/v4/manifest.json) 记录哪个 fixture 应由哪个 schema 校验，因此 Python 和 TypeScript 测试共享同一份 fixture 到 schema 的映射。

当契约字段变化时，应同时更新本目录中的相关书面规范、[schema](schemas/v4)、[fixture](fixtures/v4) 和 [manifest](fixtures/v4/manifest.json) 条目。

## Fixture 使用规则

`fixtures/v4/` 下的 fixtures 是当前项目自有契约的可执行示例。

它们会被 Python agents 包和 GitHub integration 包共同消费，确保两个实现验证同一组 JSON 结构。

包内测试应通过本包的 contract fixture helper 读取这些 fixtures，而不是在单个测试里硬编码路径：

- Python: `tests.contract_fixtures`
- TypeScript: `test/contract-fixtures.ts`

Schema 校验测试应读取 `manifest.json`，不要维护包内各自的 fixture 映射。

## 产物边界

除非某个字段明确提升进公开 workflow 结果，否则 stage 产物属于运行时诊断。公开结果包括 `review_record`、repository `case_results[]`、repository `deliveries[]`，以及 [CONTRACT_V4.zh.md](CONTRACT_V4.zh.md) 中记录的其他字段。

调用方应从 workflow result 发布结果，而不是读取整包 stage 产物。如果调用方行为必须依赖某个 stage 产物，要么把所需字段提升进本契约，要么把依赖限制在本地调试工具内。

## 变更清单

任何契约变更都应：

- 更新相关 Markdown 规范；
- 更新 [schemas/v4](schemas/v4) 下的 JSON Schema；
- 更新或新增 [fixtures/v4](fixtures/v4) 下的 fixtures；
- 让 Python 和 TypeScript 测试校验同一组 fixtures 和 schemas。
- 让 [scripts/check_contracts.sh](../scripts/check_contracts.sh) 随契约校验范围保持同步，并在发布变更前运行它。
