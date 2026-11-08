# 契约 TypeScript 代码生成

语言：[English](README.md) | 中文

本文为 [README.md](README.md) 的中文译文；如有差异，以英文版为准。

本包仅用于开发，为 Execution API、Review Runs API 和 Memory Catalog API 的工具提供共用的 OpenAPI 到 TypeScript 代码生成规则。各类契约仍分别维护规范、生成命令、输出清单、格式和生成结果一致性检查。

使用本工具的包通过 `workspace:*` 声明依赖。在仓库根目录运行 `pnpm install --frozen-lockfile`，按统一锁文件安装即可。安装依赖后即可运行，无需单独构建。

Kubb resolver 将操作响应的聚合类型命名为 `…ResponseBodyByStatus` 和 `…ResponseBody`，与 `HealthResponse` 等契约 schema 名称区分。状态码映射直接包含响应体及其生成说明，不再保留中间的 `StatusNNN` 别名。聚合类型通过索引精确选取 Kubb 选择的状态码：有成功响应时选择成功响应，否则沿用其响应体回退规则。它表示响应体，而不是携带状态码判别字段的 HTTP 响应对象。

渲染器通过 Kubb 支持的 resolver 定制命名，并对状态码映射及聚合类型进行基于语法结构的规范化。不支持的输出会导致生成失败，不会静默保留另一种形状。它不会改写无关的 schema 声明或契约数据。

在本目录运行检查：

```bash
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm test
```

公共行为测试放在这里；各 family 分别测试自己的实际契约生成物及生成一致性。修改渲染器后，应重新生成三个 family 的产物，并在消费这些产物的 package 中运行检查。
