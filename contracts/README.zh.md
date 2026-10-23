# 契约

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

本目录是项目自有契约的工作区级根目录。它同时保存契约的人类可读规范，以及执行该规范的可执行资产。

## 布局

每个契约族占一个目录，每个受支持的版本占一个子目录，内含该版本的规范、schema 和 fixture：

```text
contracts/
  <family>/
    <version>/
      <SPEC>.md        该版本的书面契约
      schemas/*.json   可机器校验的形状（当契约是数据形状时）
      fixtures/*.json  可执行示例，以及配对它们的 manifest
      corpus/*         共享的非 JSON 输入，外加 manifest（当契约是由代码强制的格式、
                       而不是数据形状时）
```

并非每个族都使用每一种资产。若契约的规则是决策逻辑而非结构形状，它会携带 `corpus/`
而不是 `schemas/` 与 `fixtures/`，并在代码中强制该格式。参见
[setup-declaration](setup-declaration/README.zh.md)。

一个族也可以存放适用于所有版本的文档，例如传输层参考。

## 契约族

- [integration-contract](integration-contract/README.zh.md)：Runner 与其调用方之间的公开集成点。当前版本：[v6](integration-contract/v6/CONTRACT.zh.md)。
- [execution-contract](execution-contract/README.zh.md)：Execution Gateway 与 Execution Worker 之间私有的 Temporal dispatch 边界。当前版本：v1。
- [control-plane-api](control-plane-api/README.zh.md)：Control Plane 与其调用方交换的形状。当前版本：[v1](control-plane-api/README.zh.md)。
- [memory-catalog-api](memory-catalog-api/README.zh.md)：Memory Catalog Server 与 Execution Worker 之间的 HTTP 边界。当前版本：v1。
- [setup-declaration](setup-declaration/README.zh.md)：仓库用来准备其审查沙箱的 `.sec-review/setup.yml` 格式。当前版本：[v1](setup-declaration/v1/SPEC.zh.md)。

## 适用于每个族的规则

族名取自这个族覆盖的内容。若所有形状都属于同一个组件，就以该组件命名——`control-plane-api` 就是 Control Plane 自己的形状；若形状横跨多方，就以它们的交汇点命名——`integration-contract` 横跨 Runner、其调用方和下游发布方。

不要用某个消费方命名，因为消费方会变、提供方不会；也不要复用别的族已用于其他含义的词。

规范、schema、fixture 和 fixture manifest 一起变更。

Schema 负责结构形状：必填字段、JSON 类型、枚举、带标签的变体，以及多余字段策略。Schema 不替代领域代码。跨字段规则留在做出该决策的 workflow 中；安全路径、平台权限、发布资格和重试行为等副作用策略留在消费者一侧。

Fixture 是契约校验的一部分。Manifest 记录每个 schema 必须接受哪些有效 fixture、必须拒绝哪些无效 fixture，因此每个实现执行同一条结构边界。

测试通过各包自己的助手读取 fixture，而不是把路径写死在单个测试里：

- Python：`tests.contract_fixtures`
- TypeScript：`test/contract-fixtures.ts`

每个族的 README 记录该边界两侧的归属，以及调用方可以依赖什么。

## 派生产物

有些产物是从手写契约生成的，而不是手工维护——例如 API 的 TypeScript 投影、提交的 JSON Schema、生成的参数列表。每个族拥有渲染并校验其投影的工具，放在 `<family>/tools/` 下：读取契约的工具就挨着契约，而它的产物落在哪里（可能在别的包中）不影响谁拥有该检查。每个族的 `tools/generated-artifacts.json` 列出它派生什么、落到哪里。

稳定的包内入口按调用方消费的职责命名，即使它由生成器维护，例如 `contract-version.ts`。原始机械投影可以在文件名中保留 `generated`，用于提示该文件不应逐渐承载手写行为，例如 `contract-types-generated.ts`。文件名不是强制边界：每个提交到仓库的生成产物都必须在文件头标明其生成身份、列入该族的 manifest，并由下述 freshness 与 CI 检查覆盖。

每个工具提供 `pnpm --dir contracts/<family>/tools run generate` 重新生成全部产物，以及 `pnpm --dir contracts/<family>/tools run check` 校验已提交副本是否一致。每个族的测试会断言 manifest 与生成器自身声明的输出一致，并断言 CI 的变更过滤器覆盖清单中每一个产物；因此新增一个投影只需把它列进清单，而不必记得再接一个检查。

## 变更清单

任何契约变更都需要：

- 更新受影响版本的规范；
- 更新它的 schema；
- 更新或新增它的 fixture 与 manifest 条目；
- 用该族的工具重新生成任何派生产物（例如 Control Plane 提交的 `v1` schema 与生成的类型）：`pnpm --dir contracts/<family>/tools run generate`，再用 `... run check` 确认；
- 让 Python 和 TypeScript 测试校验同一批文件。
