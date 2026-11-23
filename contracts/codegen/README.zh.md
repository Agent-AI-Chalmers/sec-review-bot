# 契约 TypeScript 代码生成

语言：[English](README.md) | 中文

本文为 [README.md](README.md) 的中文译文；如有差异，以英文版为准。

本包仅用于开发，为 Execution API、Review Runs API 和 Memory Catalog API 的工具提供共用的 OpenAPI 到 TypeScript 代码生成规则。各类契约仍分别维护规范、生成命令、输出清单、格式和生成结果一致性检查。

使用本工具的包通过 `workspace:*` 声明依赖。在仓库根目录运行 `pnpm install --frozen-lockfile`，按统一锁文件安装即可。本包导出 TypeScript 源码；调用方与契约工具一样，通过 `node --import tsx` 运行，无需单独构建。

`renderOpenApiTypes()` 原样输出 Kubb 的声明，并在其后追加两个以 `operationId` 为键的操作映射。使用方只通过这两个映射获取操作级类型。`OperationOptionsById` 给出每个操作的请求参数（path、query、headers、body）。`OperationResponseById` 给出成功响应体：各 2xx 状态码的响应体，没有响应体的 2xx 状态码记为 `void`。错误响应体永远不算成功；Kubb 自带的 `…ResponseBody` 聚合类型在没有带响应体的成功状态码时会回退到错误响应体，其生成说明也不以此为准。以下情况生成会直接失败，不会产出有误导性的响应体类型：操作没有任何 2xx 状态码；2xx 的 content 没有声明 schema；某个 2xx 状态码有多种内容类型；使用 `2XX` 这类状态码范围；响应引用指向 `components.responses` 以外的位置；整个 path item 使用 `$ref` 引用。Kubb 的 resolver 将各操作的聚合类型命名为 `…ResponseBodyByStatus` 和 `…ResponseBody`，避免与 `HealthResponse` 等契约 schema 名称冲突。测试通过编译器检查最终类型的含义，不要求特定的声明写法。

`formatGenerated()` 每次渲染都会读取产物目标目录最近的 `.oxfmtrc.json`。生成 Markdown 保留语义段落和嵌入示例；ignore patterns 只控制 CLI 文件选择，不阻止渲染已声明的投影。不支持的配置覆盖会明确报错，不会静默改变产物。在所属产物清单的 `code_inputs` 中登记此函数及每个目标配置。

在本目录运行检查：

```bash
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm test
```

共用生成逻辑的行为测试放在本包。各类契约另行检查自己的生成结果及其一致性。修改生成逻辑后，应重新生成上述 API 契约的文件，并在使用这些文件的各个包中运行检查。
