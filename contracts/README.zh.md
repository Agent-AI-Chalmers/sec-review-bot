# 契约

语言：[English](README.md) | 中文

本文为 [README.md](README.md) 的中文译文；如有差异，以英文版为准。

本目录集中维护各包之间使用的接口和数据格式约定。每类契约对应一个目录，保存规范，以及用于生成文件、校验输入和运行测试的工具与数据。

## Package Workspace

<!-- doc-default: node-workspace; source=pnpm-workspace.yaml -->
契约工具和 `contracts/codegen` 都在根目录的 pnpm 工作区中，与应用和服务共用锁文件。`contracts/codegen` 由契约工具的维护方负责；使用它的包通过 `workspace:*` 声明依赖。

在仓库根目录运行：

```bash
pnpm install --frozen-lockfile
pnpm run contracts:check
pnpm --filter "./contracts/**" run lint
pnpm --filter "./contracts/**" test
pnpm --filter @sec-review-bot/execution-api-tools run generate
```

安装完成后，也可以进入各工具目录运行命令。CI 在仓库根目录安装依赖，再分别检查各个包。修改依赖时，应同步更新根目录的 `pnpm-lock.yaml`。

## 布局

每类契约使用一个目录，每个受支持的版本再使用一个子目录，保存该版本的规范、schema 和测试数据：

```text
contracts/
  <contract>/
    <version>/
      <SPEC>.md        该版本的书面契约
      schemas/*.json   可机器校验的形状（当契约是数据形状时）
      fixtures/*.json  可执行示例，以及配对它们的 manifest
      corpus/*         共享的非 JSON 输入，外加 manifest（当契约是由代码强制的格式、
                       而不是数据形状时）
  <layered-contract>/
    envelope/<version>/{SPEC.md,corpus/}
    profiles/<name>/<version>/{SPEC.md,corpus/}
```

并非每类契约都有上述全部文件。规则主要涉及判断逻辑、不能只用数据结构描述时，由代码执行校验，并在 `corpus/` 中维护两端共用的测试输入，而不是使用 `schemas/` 和 `fixtures/`。例如 [setup-declaration](setup-declaration/README.zh.md)。

契约目录还可以保存适用于所有版本的文档，例如传输方式说明。

如果多种格式共用底层封装，可以在同一契约目录中使用 `envelope/` 定义封装，用 `profiles/<name>/` 定义各类内容格式。两者分别维护规范、测试输入、工具和版本号；目录嵌套不代表版本必须同步。参见 [tar-zstd-artifact](tar-zstd-artifact/README.zh.md)。

## 契约分类

| 契约类别                                                | 约定内容                                         | 参与方                                             | 当前版本                                                                                                                                                                                                      |
| ----------------------------------------------------- | -------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [execution-api](execution-api/README.zh.md)           | 公开 HTTP 操作、工作流输入、结果与错误    | Execution API 服务、调用方与结果发布方         | [v1](execution-api/v1/CONTRACT.zh.md)                                                                                                                                                                         |
| [execution-workflow](execution-workflow/README.zh.md) | Temporal Execution Workflow 输入             | Execution Gateway 与 Execution Worker              | [v1](execution-workflow/v1/CONTRACT.md)                                                                                                                                                                       |
| [review-runs-api](review-runs-api/README.zh.md)       | Review Runs HTTP API 与脱敏运行记录结构    | Review Runs 与其调用方                             | [v1](review-runs-api/v1/openapi.yaml)                                                                                                                                                                         |
| [memory-catalog-api](memory-catalog-api/README.zh.md) | 记忆协调服务的 HTTP API                 | Memory Catalog Server 与 Worker                   | [v1](memory-catalog-api/v1/openapi.yaml)                                                                                                                                                                      |
| [tar-zstd-artifact](tar-zstd-artifact/README.zh.md)   | 共享归档封装与各类产物格式 | 本项目中生成或读取 tar+zstd 产物的组件         | [envelope v1](tar-zstd-artifact/envelope/v1/SPEC.zh.md)、[input-bundle v1](tar-zstd-artifact/profiles/input-bundle/v1/SPEC.zh.md)、[memory-tree v1](tar-zstd-artifact/profiles/memory-tree/v1/SPEC.zh.md)、[run-diagnostic v1](tar-zstd-artifact/profiles/run-diagnostic/v1/SPEC.zh.md) |
| [agent-trajectory](agent-trajectory/README.zh.md) | Agent 执行轨迹（JSONL） | Agent 运行时、Memory、UI 和用量脚本 | [v1](agent-trajectory/v1/SPEC.zh.md) |
| [setup-declaration](setup-declaration/README.zh.md)   | 受信任的 `.sec-review/setup.yml` 格式        | 被审查仓库、GitHub Integration 与 Execution Worker | [v1](setup-declaration/v1/SPEC.zh.md)                                                                                                                                                                         |

## 各类契约的维护规则

契约名称应体现它约定的内容。如果数据结构都由一个组件提供，就按该组件命名，例如 `review-runs-api`；如果约定涉及多个组件，就按它们共同使用的接口命名，例如 `execution-api` 由 Execution Gateway 提供，Review Runs 提交执行请求并查询状态，GitHub Integration 使用结果向 GitHub 发布评论、修改建议或 draft PR。

不要仅按某个使用方命名，以免新增使用方后名称失去代表性；也不要把其他契约已经使用的名称用于不同含义。

修改规则时，同步更新规范、schema、测试数据及其清单。

Schema 校验必填字段、JSON 类型、枚举、带类型标签的不同结构，以及是否允许额外字段。涉及多个字段的业务判断仍由对应工作流执行；路径是否允许发布、平台权限、发布条件和重试方式等规则由使用方处理，不能只靠 schema 校验。

测试数据也是契约的一部分。清单规定每个 schema 必须接受和拒绝哪些输入，使不同语言的实现可以验证相同规则。

### 二进制与按内容寻址的产物

归档、压缩流或其他按内容寻址的产物，必须分别说明生成方和读取方的要求：生成方必须使用哪种表示，读取方可以接受哪些替代表示，以及必须拒绝哪些输入。不能直接把所用库的默认行为当成契约规则。

产物引用应同时记录媒体类型、压缩后的字节数和摘要；契约规定存储位置时，还必须绑定该位置。读取方先检查引用结构和位置，再检查实际压缩数据的大小与摘要，然后才解压或解析内容。对象存储可信、摘要匹配，都不能代替对归档路径、条目类型、元数据、资源限制和内部清单的检查。

这类契约维护真实归档文件的共享测试集（corpus），覆盖合法格式、错误结构、格式扩展、重复或歧义名称、链接、特殊条目和资源限制。所有读取方都执行同一套输入。生成方还需有专项测试，确认输出符合规范，并拒绝无法按规范编码的输入。

压力测试仍保存真实产物，但清单可以只记录 `entryCount` 等汇总信息，不必展开数千个重复条目。判断是否通过仍以实际字节和校验结果为准。

测试使用各包自己的辅助函数读取测试数据，不要在单个测试中写死路径：

- Python：`tests.contract_fixtures`
- TypeScript：`test/contract-fixtures.ts`

每类契约的 README 都应说明提供方和使用方分别负责什么，以及调用方可以依赖哪些保证。

## 派生产物

API 的 TypeScript 类型、部分 JSON Schema 和参数列表等文件由契约生成。生成和校验工具放在对应契约或分层格式的 `tools/` 目录中。即使生成结果写入另一个包，仍由这套工具负责检查；`generated-artifacts.json` 列出全部输出及其位置。

对外提供固定用途的包内文件按用途命名，例如 `execution-api-version.ts`，即使该文件由工具生成。纯生成文件可以在名称中保留 `generated`，例如 `contract-types-generated.ts`，提醒维护者不要往里添加手写逻辑。不论文件名如何，所有提交到仓库的生成文件都必须在文件头注明来源、列入输出清单，并纳入生成结果一致性检查和 CI。

各工具提供 `generate` 重新生成文件，提供 `check` 检查仓库中的结果是否一致。测试会核对输出清单与生成器声明，并检查 CI 的变更触发规则是否覆盖每个输出文件。因此新增生成文件时，应将其列入清单，由现有检查确认覆盖情况。

各 API 契约工具通过本地包依赖共用 [TypeScript 代码生成工具](codegen/README.md)，但各自维护具体契约的生成结果和检查。

## 变更清单

任何契约变更都需要：

- 更新受影响版本的规范；
- 更新它的 schema；
- 更新或新增测试输入及清单条目；
- 使用对应契约或格式层的工具重新生成派生文件（例如 Review Runs 的 `v1` schema 和类型），再运行该工具的 `check` 命令；
- 让 Python 和 TypeScript 测试校验同一批文件。
- 对二进制产物，运行生成方测试、每个读取方的共享 corpus 测试，以及至少一项从产物引用到实际字节校验的端到端测试。
