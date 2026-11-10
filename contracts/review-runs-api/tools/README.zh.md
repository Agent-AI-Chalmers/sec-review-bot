# Review Runs API 契约工具

语言：[English](README.md) | 中文

本文为 [README.md](README.md) 的中文译文；如有差异，以英文版为准。

本包根据[本类契约的 OpenAPI 文件](../v1/openapi.yaml)生成并校验 TypeScript 类型、操作路由映射和 v1 JSON Schema。工具与契约放在一起；即使生成文件写入其他包，仍由这里负责检查。

## 命令

```bash
pnpm run generate
pnpm run check
pnpm run format:check
pnpm run lint
pnpm run lint:contract
pnpm run typecheck
pnpm test
```

`generate` 和 `check` 共用各生成器的 `generatedArtifacts()` 输出描述，避免维护两份清单。`tools/generated-artifacts.json` 记录生成哪些文件及写入位置；测试会核对它与生成器一致，并检查 CI 是否覆盖每个输出文件。

## 目录结构

```text
tools/
  generated-artifacts.json   本契约派生什么、落到哪里
  src/
    generate.ts              pnpm run generate
    check.ts                 pnpm run check
    generated-artifact.ts    { output, render } 形状
    repo-root.ts             仓库根，用于构造产物绝对路径
    generate-types.ts        API 投影（类型、错误码、控制台参数）
    generate-schemas.ts      提交的 v1 JSON Schema
    generate-state-machines.ts  契约 x-state-machines 的 TypeScript 视图
  test/
    generated-artifacts.test.ts       manifest ↔ 生成器 ↔ CI 过滤器
    contract-generation-guards.test.ts  生成器在无法如实表达的输入上失败
    response-types.test.ts            每个响应别名都能索引其状态码映射
```
