# Review Runs API 契约工具

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

本包渲染并校验从[本族的 OpenAPI 契约](../v1/openapi.yaml)派生的全部产物：TypeScript 投影与提交的 v1 JSON Schema。它住在所读契约旁边，因此"拥有某个投影的工具"不是"该投影落在的包"。

## 命令

```bash
pnpm run generate        # 渲染全部产物并就地写入
pnpm run check           # 将每个已提交产物与重新渲染结果比对
pnpm run lint:contract   # 用 Spectral 依据 ../.spectral.yaml 检查 ../v1/openapi.yaml
pnpm run test            # 生成器守则、manifest 一致性、CI 过滤器覆盖
```

`generate` 与 `check` 共享同一份"什么被生成"的描述（各生成器中的 `generatedArtifacts()`），因此二者不可能不一致。`tools/generated-artifacts.json` 记录本族派生什么、落到哪里；一个测试会断言它与生成器一致，并断言 CI 覆盖清单中每个产物。

## 目录结构

```text
tools/
  generated-artifacts.json   本族派生什么、落到哪里
  src/
    generate.ts              pnpm run generate
    check-generated-artifacts.ts  pnpm run check
    generated-artifact.ts    { output, render } 形状
    repo-root.ts             仓库根，用于构造产物绝对路径
    generate-types.ts        API 投影（类型、错误码、控制台参数）
    generate-schemas.ts      提交的 v1 JSON Schema
  spectral-functions/
    operationRequiresSecurity.js     每个操作必须声明 security 的规则（../.spectral.yaml）
    operationDeclaresServerErrors.js 每个操作必须声明 500（读 body 时含 413）的规则（../.spectral.yaml）
  test/
    generated-artifacts.test.ts       manifest ↔ 生成器 ↔ CI 过滤器
    contract-generation-guards.test.ts  生成器在无法如实表达的输入上失败
```
