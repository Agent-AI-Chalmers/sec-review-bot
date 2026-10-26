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

| 契约族 | 边界 | 参与方 | 当前版本 |
| --- | --- | --- | --- |
| [execution-api](execution-api/README.zh.md) | 公开 HTTP 操作、workflow 输入、结果与错误 | Execution API provider、调用方与下游发布方 | [v1](execution-api/v1/CONTRACT.zh.md) |
| [execution-workflow](execution-workflow/README.zh.md) | Temporal Execution Workflow 输入 | Execution Gateway 与 Execution Worker | [v1](execution-workflow/v1/CONTRACT.md) |
| [review-runs-api](review-runs-api/README.zh.md) | Review Runs HTTP API 与 observed run 形状 | Review Runs 与其调用方 | [v1](review-runs-api/v1/openapi.yaml) |
| [memory-catalog-api](memory-catalog-api/README.zh.md) | Memory coordination HTTP API | Memory Catalog Server 与 workers | [v1](memory-catalog-api/v1/openapi.yaml) |
| [memory-tree-artifact](memory-tree-artifact/README.zh.md) | 不可变 memory tree archive 格式 | Memory Maintenance Worker 与 Control Plane UI BFF | [v1](memory-tree-artifact/v1/SPEC.zh.md) |
| [run-diagnostic-artifact](run-diagnostic-artifact/README.zh.md) | Completed-run diagnostic archive profile | Execution Worker、Memory Extraction Worker 与 Control Plane UI BFF | [v1](run-diagnostic-artifact/v1/SPEC.zh.md) |
| [tar-zstd-artifact](tar-zstd-artifact/README.zh.md) | 共享的受限 POSIX PAX envelope | 所有项目自有 tar+zstd producer 与 consumer | [v1](tar-zstd-artifact/v1/SPEC.zh.md) |
| [setup-declaration](setup-declaration/README.zh.md) | 受信任的 `.sec-review/setup.yml` 格式 | 被审查仓库、GitHub Integration 与 Execution Worker | [v1](setup-declaration/v1/SPEC.zh.md) |

## 适用于每个族的规则

族名取自这个族覆盖的内容。若所有形状都属于同一个组件，就以该组件命名——`review-runs-api` 就是 Review Runs 自己的形状；若形状横跨多方，就以它们的交汇点命名——`execution-api` 横跨 Execution provider、调用方和下游发布方。

不要用某个消费方命名，因为消费方会变、提供方不会；也不要复用别的族已用于其他含义的词。

规范、schema、fixture 和 fixture manifest 一起变更。

Schema 负责结构形状：必填字段、JSON 类型、枚举、带标签的变体，以及多余字段策略。Schema 不替代领域代码。跨字段规则留在做出该决策的 workflow 中；安全路径、平台权限、发布资格和重试行为等副作用策略留在消费者一侧。

Fixture 是契约校验的一部分。Manifest 记录每个 schema 必须接受哪些有效 fixture、必须拒绝哪些无效 fixture，因此每个实现执行同一条结构边界。

### 二进制与内容寻址 artifact

对于 archive、压缩 stream 或其他内容寻址 artifact，规范必须区分生产者义务与消费者义务。应明确生产者必须输出哪种表示、消费者可以接受哪些替代表示，以及所有消费者必须拒绝哪些输入。库的默认行为属于实现细节，不是契约规则。

若契约定义了规范存储位置，artifact reference 必须同时绑定声明的 media type、压缩字节大小、digest 与规范位置。消费者先验证 reference 形状和位置，再验证压缩大小与 digest，之后才能解压或进行语义解析。对象存储可信或 digest 匹配，不能代替对 archive 路径、entry 类型、元数据、限制和内部 manifest 的验证。

契约族拥有一套共享的真实编码字节 corpus。它应覆盖合法互操作案例、错误结构、表示扩展、重复或歧义名称、link 与特殊 entry，以及具体资源限制。每个消费者执行同一套 corpus。每个生产者也应有聚焦测试，证明其输出等价于合法 corpus，并拒绝那些若编码就会离开规范格式的输入。

压力 fixture 仍保留真实 artifact，但其可读 manifest 可以记录 `entryCount` 等聚合事实，而不展开数千个重复 entry。fixture 字节与 validator 结果仍是判定依据。

测试通过各包自己的助手读取 fixture，而不是把路径写死在单个测试里：

- Python：`tests.contract_fixtures`
- TypeScript：`test/contract-fixtures.ts`

每个族的 README 记录该边界两侧的归属，以及调用方可以依赖什么。

## 派生产物

有些产物是从手写契约生成的，而不是手工维护——例如 API 的 TypeScript 投影、提交的 JSON Schema、生成的参数列表。每个族拥有渲染并校验其投影的工具，放在 `<family>/tools/` 下：读取契约的工具就挨着契约，而它的产物落在哪里（可能在别的包中）不影响谁拥有该检查。每个族的 `tools/generated-artifacts.json` 列出它派生什么、落到哪里。

稳定的包内入口按调用方消费的职责命名，即使它由生成器维护，例如 `execution-api-version.ts`。原始机械投影可以在文件名中保留 `generated`，用于提示该文件不应逐渐承载手写行为，例如 `contract-types-generated.ts`。文件名不是强制边界：每个提交到仓库的生成产物都必须在文件头标明其生成身份、列入该族的 manifest，并由下述 freshness 与 CI 检查覆盖。

每个工具提供 `pnpm --dir contracts/<family>/tools run generate` 重新生成全部产物，以及 `pnpm --dir contracts/<family>/tools run check` 校验已提交副本是否一致。每个族的测试会断言 manifest 与生成器自身声明的输出一致，并断言 CI 的变更过滤器覆盖清单中每一个产物；因此新增一个投影只需把它列进清单，而不必记得再接一个检查。

## 变更清单

任何契约变更都需要：

- 更新受影响版本的规范；
- 更新它的 schema；
- 更新或新增它的 fixture 与 manifest 条目；
- 用该族的工具重新生成任何派生产物（例如 Review Runs 提交的 `v1` schema 与生成的类型）：`pnpm --dir contracts/<family>/tools run generate`，再用 `... run check` 确认；
- 让 Python 和 TypeScript 测试校验同一批文件。
- 对二进制 artifact，运行生产者测试、每个消费者的共享 corpus 测试，以及至少一条从 reference 到字节验证的端到端路径。
