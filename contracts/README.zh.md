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
      schemas/*.json   可机器校验的形状
      fixtures/*.json  可执行示例，以及配对它们的 manifest
```

一个族也可以存放适用于所有版本的文档，例如传输层参考。

## 契约族

- [integration-contract](integration-contract/README.zh.md)：Runner 与其调用方之间的公开集成点。当前版本：[v5](integration-contract/v5/CONTRACT.zh.md)。
- [control-plane-api](control-plane-api/README.zh.md)：Control Plane 与其调用方交换的形状。当前版本：[v1](control-plane-api/README.zh.md)。

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

## 变更清单

任何契约变更都需要：

- 更新受影响版本的规范；
- 更新它的 schema；
- 更新或新增它的 fixture 与 manifest 条目；
- 让 Python 和 TypeScript 测试校验同一批文件；
- 保持 [scripts/check_contracts.sh](../scripts/check_contracts.sh) 与校验面一致，并在发布该变更前运行它。
