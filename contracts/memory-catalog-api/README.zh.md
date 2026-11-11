# Memory Catalog API

语言：[English](README.md) | 中文

本文为 [README.md](README.md) 的中文译文；如有差异，以英文版为准。

Memory Catalog Server 的 HTTP 接口定义在人工维护的 [v1/openapi.yaml](v1/openapi.yaml) 中。服务依据它注册路由和校验规则；服务端与 Control Plane UI 使用由它生成的 TypeScript 类型。Python 客户端通过契约测试检查发出和接收的数据是否符合约定。

extraction（已完成的经验提取记录）和 observation 列表按从新到旧的确定顺序返回。分页游标不透明，调用方不应解析其内容；下一页不重复包含游标对应项。使用 `next_cursor` 翻页时必须保持过滤条件不变。修订历史使用公开的 `before_revision` 游标，同样不包含游标对应的修订；修订编号不可变且单调递增。

`GET /v1/overview` 直接根据 Catalog 状态统计已完成提取的单元，以 `(source_run_id, source_unit_id)` 标识。同一单元至少完成过一次提取、但所有提取都未产出 observation 时，归为“未产出 observation”；失败或尚未结束的提取不计入。`range` 可选 30 天、90 天或全部历史；`trend_points` 按 `trend_granularity` 声明的粒度返回，有限时间范围按日、全部历史按月统计。`period_start` 是对应自然日或自然月的 UTC 起始日期，包含该起点。

记忆修订通过 `source` 区分来源：`learning` 包含 `operation_id`、已处理的提取 ID 和 `trajectory_reference`；`reorganization` 包含 `operation_id` 和 `trajectory_reference`，但不消费 observation；两类自动修订还携带 maintainer 的 `maintenance_report`：一段总结，以及对每个已消费提取的一条决定（`added`、`merged`、`skipped` 或 `conflict`，附修改的主题和理由），`reorganization` 的决定列表为空，且报告属于发布意图精确匹配的一部分；`manual` 请求包含用于幂等处理的 `operation_id`，保存修订时再根据认证凭据补充操作者信息。`operation_id` 在所有来源类型中唯一标识一次修订操作；以不同类型复用同一 ID 会产生冲突。`predecessor_revision` 记录创建修订时的生效版本。恢复版本是独立的幂等操作：通过比较并交换（CAS）将当前版本指向已有修订，不创建新修订。

Worker 凭据允许登记 extraction、读取 learning 输入和提交 learning 或 reorganization 修订。Operator 凭据允许暂停或恢复记忆树自动更新、提交人工修订和恢复已有版本。两类凭据都能读取共享目录数据；创建修订时，请求来源类型必须与认证角色匹配。

`GET /v1/memory-tree/automation` 返回 `enabled` 或 `paused`，表示是否允许提交新的 `learning` 和 `reorganization` 修订。暂停时，这些提交返回 HTTP 409 和 `AUTOMATION_PAUSED`；暂停不会中止已运行的任务，也不阻止产物发布、extraction 登记、`manual` 修订、恢复版本或成功提交的相同请求重放。`/pause` 和 `/resume` 请求通过 `operation_id` 保证幂等，并用 `expected_generation` 做 CAS 检查。响应包含 `created` 和 `automation` 状态快照。相同请求重放时返回该操作原先产生的快照，即使当前状态后来已经改变。

发布 extraction 或记忆修订时，先登记发布意图，记录完整结果和文件引用；上传文件后，再由上传方确认这些文件已存在。Catalog 以上传方的确认为准，自身不检查对象存储。正式登记结果时，Catalog 要求提交内容与已确认的发布意图一致，并在同一事务中完成登记和意图选定。

发布中断后，调用方可以查询已记录的意图，用于重试。Catalog 会保留这些记录，但不会自动完成中断的发布，也不会自动清理相关对象。

Worker 可以通过 `POST /v1/memory-tree/revisions/publications/abandon` 放弃已有且未选定的 `learning` 或 `reorganization` publication。这些 publication 变为 `abandoned`；重试不会恢复它们，提交它们会返回 HTTP 409 和 `PUBLICATION_ABANDONED`。新的自动提交在暂停期间被拒绝时，会在同一事务中放弃该来源类型和 operation ID 下已有且未选定的 publication。维护 workflow 在准备阶段发现暂停时放弃这些 publication，遇到暂停或放弃后正常退出，不再因 backlog 续跑。已选定的 publication 和共用的产物对象会保留。

## 工具

在 `tools/` 中运行：

```bash
pnpm run generate
pnpm run check
pnpm run format:check
pnpm run lint
pnpm run lint:contract
pnpm run typecheck
pnpm test
```

每次 extraction 可以产出零到多条 observation。`extraction_id` 标识调用及其来源；`observation_id` 标识可独立维护的经验。注册操作原子发布完整的 `observations` 数组；learning 消费 `observation_ids`，并为每条 observation 记录一个决定。

这是不兼容的 schema 和 API 变更。已有 Memory Catalog 数据库必须重建，worker 与服务端必须同步更新；旧的单 observation 请求和待处理 workflow payload 不受支持，不提供迁移或兼容适配层。

Observation ID 是全局唯一的不透明标识，API 不要求 extraction ID 前缀。另一条 extraction 使用已占用的 observation ID 时，返回 HTTP 409，并回滚整次注册。分页游标是不透明的，排序位置使用当前列表的行 ID。
