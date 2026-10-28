# Input Bundle Artifact

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

本目录定义将已准备 review input 从 Execution API caller 传递给 Execution Worker 的不可变 archive。它是共享 [envelope v1](../../envelope/v1/SPEC.zh.md) 上的 profile。

- [v1/SPEC.zh.md](v1/SPEC.zh.md) 定义 tree、canonical production 规则与资源限制。
- [v1/corpus](v1/corpus) 包含每个 input-bundle consumer 除共享 envelope corpus 外还必须执行的真实 archive。

Execution API 拥有 reference object 与 workflow-specific manifest schema。本 profile 拥有 archive representation 与 tree boundary；它不定义 preparation retry 或 object-storage lifecycle policy。

## Tooling

```bash
pnpm run generate
pnpm run check
pnpm run test
```

请从 `contracts/tar-zstd-artifact/profiles/input-bundle/tools/` 运行这些命令。
