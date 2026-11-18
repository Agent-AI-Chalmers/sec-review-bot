# Oxc 工具链评估

评估日期：2026-11-18。本报告记录迁移前的实验与建议；实验阶段未修改格式化器、linter、依赖、hook 或生成器配置。后续迁移采用下文的职责划分与验收标准；声明空行经复核后作为代码评审约定保留，不引入专用插件。

## 结论与目标

建议推进 Oxfmt 和 Oxlint 的迁移，分开验证两者。目标是缩短反馈时间、减少配置与插件依赖，同时保留正确性检查和生成物的确定性。节省 LLM token 不作为迁移目标。

迁移应围绕检查目的重新选择规则：用原生 import 位置规则替代自定义 selector，保留类型感知的正确性检查，声明之间的空行作为代码评审约定保留。Markdown lint 和中文排版检查继续承担各自职责。

契约生成器的核心要求是：**生成产物符合最终格式规则，随后运行格式化不产生额外变化；重复生成结果稳定。** 新工具达到这个效果即可。迁移可以调整生成器最后的格式化步骤、使用新的 API 或 CLI，无须复刻 Prettier 的配置解析接口，也无须保留它原先的具体换行。迁移时首次统一排版产生的 diff 应单独审查；契约字段、结构和运行行为仍须保持预期。

## 职责与取舍

| 目的                                    | 建议                         | 理由                                           |
| --------------------------------------- | ---------------------------- | ---------------------------------------------- |
| 源码、编辑器、CI 与生成器的格式一致     | 由 Oxfmt 负责                | 生成物落盘后应直接通过格式检查。               |
| 行宽、引号、分号、尾逗号                | 初期保留当前设置             | 先验证换工具的收益，行宽调整另行决定。         |
| 声明之间的空行                          | 作为代码评审约定保留         | 避免仅为空行增加插件及其 peer dependencies。   |
| import 位于可执行语句之前               | 使用 Oxlint `import/first`   | 直接表达目的，并允许模块指令在 import 前。     |
| UI 函数显式返回类型                     | 初期保留原生 TypeScript 规则 | 已有原生能力，不必因迁移同时改变策略。         |
| 未处理 Promise、不安全赋值              | 使用 Oxlint 类型感知规则     | 保护运行时正确性，不能被更快的纯语法检查替代。 |
| 未使用变量及其他推荐规则                | 逐项映射规则和严重级别       | 两个工具的默认规则并不等价。                   |
| 模块依赖边界                            | 保留现有 AST 与依赖检查      | import 排序不能替代架构边界检查。              |
| Markdown 结构、链接、语义段落及中文间距 | 保留仓库现有检查             | 普通格式化不能覆盖这些文档要求。               |

## 格式化实测

<!-- doc-time-sensitive: oxc-evaluation-versions; checked=2026-11-18; source=https://www.npmjs.com/package/oxfmt -->

临时环境安装了 Oxfmt 0.79.0、Oxlint 1.94.0 和 oxlint-tsgolint 7.0.2007，对照组为仓库当前安装的 Prettier、ESLint。安装位置是 `/tmp/sec-review-oxc-evaluation`，未修改仓库依赖清单或 lockfile。

实验枚举 Git 跟踪的 JS、TS、TSX、CSS、JSON、JSONC、YAML 和 Markdown 文件，使用每个文件现有的 Prettier 配置及最近包目录的 ignore 文件筛选，再将对应选项直接传给 Oxfmt Node API。import、package.json 和 Tailwind 排序均关闭。这是在选定文件上比较两个格式化引擎，尚未验证 Oxfmt CLI 的配置发现和忽略行为。

| 测量项                                      | 结果                      |
| ------------------------------------------- | ------------------------- |
| 纳入文件                                    | 819 个                    |
| 解析或格式化诊断                            | 无                        |
| 与 Prettier 输出不同的文件                  | 25 个：24 个 TS、1 个 TSX |
| 差异文件再次经 Oxfmt 格式化                 | 25 个均无新增变化         |
| 差异输出经 TypeScript parser/printer 归一化 | 25 个均一致               |
| 纳入的 Markdown、JSON、YAML、CSS 输出差异   | 无                        |

差异示例主要是联合类型及类型断言换行。parser/printer 归一化一致是一项初步检查，不能证明语义完全等价，也不能替代包级验证。生成类型文件也包含在差异中，因此正式迁移应同步调整生成器的最终输出步骤，避免生成器与格式化器反复改写同一文件。

对选取的 250 个 JS/TS/CSS 文件，三次进程内顺序格式化耗时分别为：Prettier 1130/1046/1046 ms，Oxfmt 62/69/78 ms。按中位数计算，后者约快 15 倍。该测量不含文件读取和配置解析，属于 API 热运行；样本是按路径顺序取前 250 个匹配文件，未经随机抽样，不能据此推算整体 CI 提速。

## Lint 实测

每个包运行三次，单位为秒：

| 包                   | 现有 ESLint           | Oxlint 默认语法检查   |
| -------------------- | --------------------- | --------------------- |
| Control Plane UI     | 1.974 / 1.846 / 1.817 | 0.058 / 0.058 / 0.059 |
| Execution Gateway    | 2.660 / 2.584 / 2.434 | 0.042 / 0.035 / 0.043 |
| Review Runs 契约工具 | 0.538 / 0.545 / 0.564 | 0.038 / 0.033 / 0.038 |

这组数据不是规则等价条件下的加速比：ESLint 经包级命令启动，而且 Gateway 的对照检查包含类型感知规则。不能因为默认检查更快，就直接用它替代现有策略。

开启类型感知检查后，Gateway 耗时 0.517/0.745/0.796 秒，Memory Catalog 为 0.591/0.563/0.631 秒，smoke probes 为 0.386/0.403/0.382 秒。该探针启用 correctness 类别，以及显式的未处理 Promise、不安全赋值规则，尚未完成全部规则映射。Gateway 报告了两项 `no-misused-spread`；Catalog 报告了三项同类诊断和两项 `require-array-sort-compare`。正式启用时需要核对测试替身的意图和排序语义。Smoke probes 通过。

临时违规样例确认以下原生规则能够产生诊断：`import/first`、`typescript/explicit-function-return-type`、`typescript/no-floating-promises`、`typescript/no-unsafe-assignment` 和 `typescript/no-explicit-any`。将 `no-restricted-syntax` 配成原生 ESLint 规则时，Oxlint 拒绝加载配置。实验未自动修复仓库源码。

## 集成方式与待验证项

<!-- doc-time-sensitive: oxc-evaluation-api; checked=2026-11-18; source=https://github.com/oxc-project/oxc/blob/main/apps/oxfmt/src-js/index.ts -->

Oxfmt 的 `format(fileName, sourceText, options)` API 不自动发现配置，返回值包含代码和诊断。所检查的公开入口没有 `resolveConfig` 对应接口。这是调用方式的差异，不是迁移阻碍。生成器可以直接传入最终选项，或让生成流程最后调用 CLI；选择最简单且能保证生成结果稳定的方式即可。[官方 API 源码](https://github.com/oxc-project/oxc/blob/main/apps/oxfmt/src-js/index.ts)。

仓库的 execution-api、memory-catalog-api 和 review-runs-api 生成器包含程序化格式化调用。迁移应更新这些调用方，重新生成投影，并验证以下闭环：

1. 运行生成命令，得到符合最终规则的产物。
2. 运行格式检查，直接通过；运行格式化，不产生额外 diff。
3. 再次运行生成命令，产物不变。
4. 运行契约及消费包检查，确认接口和行为符合预期。

还需要验证根目录与包级忽略规则、必须保持原始字节的 fixtures、文档代码围栏、生成 Markdown、pre-commit hook、CI 变更范围路由及编辑器入口。

<!-- doc-time-sensitive: oxc-evaluation-markdown; checked=2026-11-18; source=https://oxc.rs/docs/guide/usage/formatter/config-file-reference -->

Oxfmt 支持关闭嵌入语言格式化并保留 prose 换行，能够用于保持文档示例及语义段落。但实际迁移仍须验证 CLI 配置发现和忽略行为。[格式化选项](https://oxc.rs/docs/guide/usage/formatter/config-file-reference)。

<!-- doc-time-sensitive: oxc-evaluation-js-plugins; checked=2026-11-18; source=https://oxc.rs/docs/guide/usage/linter/js-plugins -->

Oxlint JS 插件能力仍为 alpha。优先采用能直接表达所需策略的原生规则；声明空行作为评审约定保留，不为此增加插件及其 ESLint peer dependency。[JS 插件](https://oxc.rs/docs/guide/usage/linter/js-plugins)、[import 位置](https://oxc.rs/docs/guide/usage/linter/rules/import/first)、[类型感知检查](https://oxc.rs/docs/guide/usage/linter/type-aware.html)。

## 正式迁移验收标准

1. 为当前有效规则记录取舍：保留、用符合目的的原生规则替代，或说明原因后删除。正确性所依赖的错误级别不能悄悄降级。
2. 用聚焦违规样例验证 import 位置、模块指令、未使用变量、未处理 Promise、不安全赋值及选定的返回类型策略。
3. 生成器直接产出最终格式，格式化与重复生成均不产生额外变化。保留原始字节 fixtures 的排除规则及 agent Markdown 要求。
4. 在最终规则和真实文件发现方式下测量 CLI 冷、热运行，对比完整包级命令耗时。
5. 完成受影响包、契约及消费包、文档检查，并验证实际 hook 和编辑器入口。新工具承担完整职责后，再删除旧依赖和配置。

本轮结果支持推进迁移；规则完整性、CLI 配置行为、生成闭环、编辑器集成和端到端 CI 提速仍需在实施时验证。

## 实验记录

临时目录为 `/tmp/sec-review-oxc-evaluation`，包含 `format-eval.mjs`、`diff-eval.mjs`、`semantic-eval.mjs`、格式化结果 JSON、逐文件输出对照、lint 诊断及耗时 JSON。这些是一次性实验材料，不作为维护中的仓库脚本。实验使用 Oxfmt Node API、`oxlint --type-aware`、包级 `pnpm exec eslint` 和违规样例探针。官方能力核查笔记位于 `/tmp/oxc-official-evaluation.md`。
