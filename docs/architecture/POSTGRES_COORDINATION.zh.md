# 在 PostgreSQL 中协调工作

语言：[English](POSTGRES_COORDINATION.md) | 中文

本文为 [POSTGRES_COORDINATION.md](POSTGRES_COORDINATION.md) 的中文译文；如有差异，以英文版为准。

Review Runs 和 Memory Catalog 把协调状态放在各自的 PostgreSQL 数据库里，用手写 SQL 修改。它们没有使用工作流引擎、ORM 或类型化 SQL 生成器，有些语句长达几十行。本文说明这些 SQL 为什么写成这样、两个服务各自怎么用、评估过哪些替代方案，以及修改语句时要检查什么。

如果打算替换协调层、把查询挪到别处或缩短它们，请先读本文。

## 两个服务要解决的问题

worker、connector 和控制台可能同时操作同一条记录，任何一方都可能做到一半就停下。有些效果还发生在数据库之外，例如 GitHub 上的 pull request 或 S3 里的对象。PostgreSQL 事务回滚不了这些效果，进程崩溃之后也可能没人知道它们是否已经发生。

一个典型的例子：某个 GitHub Integration 进程领取了一个已完成的 run，打开了一个 draft pull request，在把它记下来之前崩溃了。之后另一个进程领取同一个 run。如果它只相信数据库，就会再开一个 pull request；如果它反过来假定第一个已经存在，就可能报告一个从未完成的交付。

因此两个服务都保证三件事：

- 只有一个写入者做决定。多个写入者竞争时，只有一个能修改记录，其他写入者会知道自己输了，而不是覆盖赢家的结果。
- 重试是安全的。响应丢失后重复同一个请求，得到的是原来的结果，不会把工作再做一遍。
- 结果未知时先核实再下结论。外部效果可能发生也可能没发生时，服务记下这份不确定，先去看外部系统再做决定。

只有检查和写入是原子的，也就是在同一个事务里、对同一条语句锁住或比较过的行进行，这些保证才成立。用 SQL 写出这一点，正是语句变长的原因。

## 本文用到的术语

- claim 授权领取者使用 claim token 处理某条记录，并在工作期间为租约续期。租约过期后，其他进程可以领取这份工作。
- 轴（axis）是 Review Runs 中一个 run 的一条生命周期。每个 run 有三条：preparation、execution 和 publication，各自有独立的状态。
- publication step 是一次 publication 中的一个外部副作用，例如为某个仓库交付打开的一个 draft pull request。每个 step 有自己的状态和尝试预算。
- `uncertain` 和 `disconnected` 在不同轴上对应不同的恢复条件；解释运行状态时，必须同时看所属轴和状态值。
- Memory Catalog 用 `automation.version` 标识自动化开关状态的版本，用 `active_version` 标识当前生效的记忆树版本。写入时带上 `expected_version` 或 `expected_active_version`，服务端据此拒绝基于过时状态的操作。

<!-- doc-default: publication.claim-ownership; source=services/review-runs/src/persistence/publication-store.ts -->

对于 publication，租约到期允许其他进程接管，但不会单独使当前 token 失效。在接管替换 token 或释放操作清空 token 之前，当前 owner 仍可续租或写入。`uncertain` 和 `disconnected` 保留 owner，让它执行允许的 step 核对。处于 disconnected 的 publication 不能被自动认领，也不能由 owner 整体收尾；运维人员可以恢复或放弃，两种决定都会清空 token 和租约时间戳。

## 各轴的恢复含义

<!-- doc-default: review-runs.recovery-meaning; source=contracts/review-runs-api/v1/openapi.yaml -->

| 范围             | `uncertain`                                                                 | `disconnected`                                             |
| ---------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Preparation      | 准备者回报前认领已过期；可以重新认领，确认或重新构造输入。                  | 运行自身的记录不允许自动收尾，例如准备过期时执行已经推进。 |
| Execution        | 提交可能已到达 Execution Gateway，但响应未确认；恢复时重放同一个 `run_id`。 | 提交恢复预算用尽，仍未得到确定答复。                       |
| Publication step | 尝试次数用尽，远端写入可能已生效；connector 先核对再下结论。                | 核对预算用尽，仍未得到确定答复。                           |
| Publication 轴   | 某步骤的远端结果不确定。                                                    | 某步骤的核对已停止，需要操作员决定。                       |

`disconnected` 会停止对应范围的自动恢复。恢复操作将符合条件的范围交回自动处理；准备阶段只有在 execution 仍为 `pending` 时才能恢复。放弃等待记录操作员不再等待的决定，并不能证明远端副作用没有发生。Abandon 则是准备阶段针对矛盾记录的独立操作。允许的操作和后果见 [Review Runs 指南](../../services/review-runs/README.zh.md)及契约。

发布步骤的 `failed` 表示上一次尝试失败：剩余次数允许重试，次数用尽后转为核对。`terminal_failed` 才是步骤的最终失败。轴的 `failed` 则是终态结论。不能脱离所属范围，仅凭 `failed` 判断是否还会重试。

## 其他状态边界

运行的轴并不涵盖所有队列或发布候选。输入和记忆候选的转换见 [artifact 发布](ARTIFACT_PUBLICATION.zh.md#发布候选状态)。

<!-- doc-default: review-runs.notice-transitions; source=services/review-runs/src/persistence/run-notices.ts -->

运行通知从 `pending` 开始，认领后进入 `delivering`，最终成为 `delivered` 或 `failed`。过期的投递可以用新 token 重新认领，状态仍为 `delivering`。恢复失联轴时，会在同一事务中将尚未投递的 attention 通知作废（`pending` 或 `delivering → superseded`），同时使其认领失效。恢复不会作废已投递通知或 failure 通知。通知的 `failed` 表示通知投递失败，不代表审查结果。

<!-- doc-default: review-runs.statistics-transitions; source=services/review-runs/src/statistics/execution-statistics-store.ts -->

执行统计有独立的 `pending → reconciling` 认领循环。读取成功后，若仍需等待观测稳定，会回到 `pending`；观测稳定或收集窗口结束后进入 `settled`。读取失败可以回到 `pending`；读取失败重试或限流延期耗尽后进入 `unavailable`。中断的认领可以被重新领取。`ingestion_status` 解释收集到的快照是否完整，`usage_coverage` 描述用量上报情况；两者都不是执行生命周期状态。

<!-- doc-default: execution-gateway.status-projection; source=services/execution-gateway/src/temporal-execution-client.ts -->

Execution Gateway 每次读取时投影 Temporal 状态，不另存一张运行状态表。Temporal 的 `RUNNING` 对应 `running`；已完成 workflow 只有在成功信封、结果、workflow 标识和 artifact 引用通过验证后，才成为 `succeeded`。已完成但无效或不成功的结果，以及其他终态 Temporal 状态，都映射为 `failed`。提交后暂时还没有执行记录时，可以立即返回 `queued`。Review Runs 独立记录它对该 API 的观测，因此 Gateway 状态和协调恢复状态回答的是不同问题。

## 共同原则

- 决定在数据库里做出。每次协调性写入都在修改状态的同一个事务中锁住或比较当前状态。应用代码从不先读出状态、在内存里判断、再在另一步中写回。
- 调用方说明自己的预期。写入时带上它预期要替换的状态：Review Runs 中是 claim token，Memory Catalog 中是预期的 version 或当前 version。不匹配说明另一个写入者赢了。
- 重试以调用方选定的标识为键。用相同的 `run_id`、入口键或 `operation_id` 和相同内容重复请求，会返回原来的结果。标识相同但内容不同则视为冲突。
- 执行外部效果之前先记录意图。上传对象或写入远端系统之前，服务先记下它要做什么。重试从这份记录出发，先检查外部系统，而不是假定效果不存在。
- SQL 紧挨着执行它的代码。只在一处使用的查询保持内嵌，这样解释锁或条件的注释就在它解释的子句旁边。在多条语句中重复出现、承载同一条规则的片段，会提取为具名的模块常量。这种常量只由模块内的字面量构成，从不包含调用方输入。

## 各服务如何落实

| 关注点             | Review Runs                                                                                    | Memory Catalog                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 由谁执行           | 持有 claim 的一方。worker 或 connector 领取工作，并在工作期间续租                              | 每个 HTTP 请求，只在一个事务内持有锁                                                                  |
| 串行化写入者       | 对工作行使用 `SELECT ... FOR UPDATE` 和 `FOR UPDATE SKIP LOCKED`                               | 对 operation 或 extraction 标识使用 `pg_advisory_xact_lock`，并对单例状态行使用 `FOR UPDATE`          |
| 发现自己输掉竞争   | claim token 不再匹配，写入不修改任何行，返回 `false`                                           | 预期的 version 或当前 version 不再匹配，服务返回 HTTP 409                                             |
| 不确定的外部效果   | 行变为 `uncertain`，由 connector 对账。对账得不出结论时变为 `disconnected`                     | 发布意图先预留，上传后确认，注册时选定。存储错误视为不确定，并使本次尝试失败                          |
| 审计记录           | 每个轴和每个 publication step 的状态转换都在同一事务中写入 `review_run_events`                 | version、恢复操作和发布意图本身就是持久记录                                                           |
| 生命周期的唯一来源 | [Review Runs API 契约](../../contracts/review-runs-api/v1/openapi.yaml)中的 `x-state-machines` | schema 中的 `CHECK` 约束和 [Memory Catalog API 契约](../../contracts/memory-catalog-api/README.zh.md) |

GitHub Integration 自己不保存协调状态。它是 Review Runs 协议的客户端：领取工作、续租，把续租失败视为失去持有权，并在报告不确定 step 的结果之前先核对 GitHub。

### Review Runs 的特有规则

Review Runs 承载的协调状态最多，因此有一些 Memory Catalog 不需要的规则：

- 不匹配是正常结果。前置条件不再成立的写入不会修改任何东西，调用方把 `rowCount !== 1` 理解为"你已经不再持有这份工作"。如果改为抛出数据库错误，会中止外层事务，因此前置条件保留在 `WHERE` 子句中。
- 写 step 要在 publication 锁之下进行。任何对 `publication_steps` 的写入都先锁住所属的 `publications` 行。单条 `UPDATE ... FROM publications` 读取 publication 时并不加锁，并发的结束操作可能在读和写之间提交。
- step 各自结束。终态的 step 失败只结束这一个 step，publication 是否继续由 connector 决定。connector 先发布其余 step，再通过 `complete`（只要还有 step 未成功就会被拒绝）或 `fail` 结束 publication。对账查询持续失败的 step 也不会拦住其他 step：它只消耗自己的预算，最终停放为 `disconnected`，其他 step 照常尝试。
- 三个轴行为一致。publication 轴与 preparation、execution 轴一样存储 `uncertain` 和 `disconnected`，由其 steps 推导而来，因此运维队列、通知和控制台以相同方式处理三个轴。

## 评估过的替代方案

<!-- doc-time-sensitive: pgtyped-typescript-support; checked=2026-11-15; source=https://github.com/adelsz/pgtyped/blob/master/packages/cli/package.json -->
<!-- doc-time-sensitive: safeql-node-postgres-integration; checked=2026-11-15; source=https://safeql.dev/compatibility/node-postgres.html -->

| 替代方案                                                                                     | 未采用的原因                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 用 [Temporal](https://temporal.io/) 工作流做协调                                             | Temporal 会重试 activity，但无法判断 GitHub 写入或上传是否已经发生，对账逻辑仍然要自己写。协调状态也会离开 PostgreSQL，而 operator 和测试目前直接查询它。Temporal 仍然是 review 和记忆工作流的执行引擎。    |
| ORM 或查询构建器，例如 [Drizzle](https://orm.drizzle.team/) 或 [Kysely](https://kysely.dev/) | 加锁、带条件的更新和 `RETURNING` 变化前的状态，通过构建器写出来更难读；把带条件的更新拆成一次读加一次写，又会把竞态带回来。                                                                                 |
| 把查询移到 `.sql` 文件                                                                       | SQL 放到另一个文件里也一样长，而每个条件都会离开解释它的注释。                                                                                                                                              |
| [PgTyped](https://pgtyped.dev/)（从 SQL 生成类型）                                           | 无法为插入了模块常量的查询生成类型。两个 schema 都用 `CHECK` 约束而不是 enum，它会把状态列放宽成 `string`。生成类型时需要一个运行中的数据库，而且评估时它支持的 TypeScript 版本范围不包含本仓库使用的版本。 |
| [SafeQL](https://safeql.dev/)（对照真实数据库的 ESLint 检查）                                | 只检查带 `sql` 标签的模板，现有调用点都要改写，漏改的调用点会悄悄通过。它把插入的常量当作参数，无法根据 `WHERE` 子句收窄状态联合类型，lint 时还需要数据库。                                                 |
| 由数据库强制检查转换（合法转换表加触发器或约束）                                             | 大多数 `WHERE` 条件检查的是持有者、预期版本和预算，转换表表达不了这些。在 Review Runs 中，把剩下的合法性检查移进数据库，会让输掉的竞争变成中止事务的错误，而边覆盖测试已经能拒绝未声明的转换。              |
| Review Runs 的 publication 只存自己的结论，读取时从 steps 投影状态                           | publication 轴就不再和另外两个轴行为一致：停滞运行队列、运维决定和通知都要为 publication 单独写规则，契约还要新增"投影状态"这个概念。                                                                       |

## 如何让 SQL 可以放心修改

只要改错能被发现，长语句就可以接受。

在 Review Runs 中：

- 状态机边覆盖测试驱动每一条写路径，并把记录下来的转换及其原因码与契约比对。
- 同一个测试检查每个仍被持有的 publication 轴与其 steps 是否一致，忘记重新推导轴状态的写路径会导致测试失败。
- 每处锁顺序和条件旁边的注释说明了它防止的竞态，以及如何复现。

在两个服务中：

- 集成测试在真实的 PostgreSQL 数据库上运行冲突、重放、暂停和放弃等路径。
- 集成测试断言时间字段离开各自的 store 时是 ISO 字符串。node-pg 把 `timestamptz` 列返回为 `Date`，而 JSON 序列化会掩盖这个差异。

修改一条语句时，把它的前置条件留在同一条语句里，把审计或通知的写入留在同一个事务里，并运行该服务的 PostgreSQL 集成测试。某个片段开始重复出现时，给它起个名字。新增状态或 step 类型属于契约变更。
