# Memory Catalog API

语言：[English](README.md) | 中文

本文为 [README.md](README.md) 的中文译文；如有差异，以英文版为准。

Memory Catalog Server 的 HTTP 接口定义在人工维护的 [v1/openapi.yaml](v1/openapi.yaml) 中。服务依据它注册路由和校验规则；服务端与 Control Plane UI 使用由它生成的 TypeScript 类型。Python 客户端通过契约测试检查发出和接收的数据是否符合约定。

extraction（已完成的经验提取记录）和 observation 列表按从新到旧的确定顺序返回。分页游标不透明，调用方不应解析其内容；下一页不重复包含游标对应项。使用 `next_cursor` 翻页时必须保持过滤条件不变。修订历史使用公开的 `before_revision` 游标，同样不包含游标对应的修订；修订编号不可变且单调递增。

`GET /v1/overview` 直接根据 Catalog 状态统计已完成提取的单元，以 `(source_run_id, source_unit_id)` 标识。同一单元至少完成过一次提取、但所有提取都未产出 observation 时，归为“未产出 observation”；失败或尚未结束的提取不计入。`range` 可选 30 天、90 天或全部历史；`trend_points` 按 `trend_granularity` 声明的粒度返回，有限时间范围按日、全部历史按月统计。`period_start` 是对应自然日或自然月的 UTC 起始日期，包含该起点。

记忆修订通过 `source` 区分来源：`maintenance` 包含维护任务身份、已处理的提取 ID 和执行轨迹引用；`operator` 请求包含用于幂等处理的操作 ID，保存修订时再根据认证凭据补充操作者信息。`predecessor_revision` 记录创建修订时的生效版本。恢复版本是独立的幂等操作：通过比较并交换（CAS）将当前版本指向已有修订，不创建新修订。

Worker 凭据允许登记 extraction、读取维护输入和提交自动维护修订。Operator 凭据允许暂停或恢复维护、提交人工修订和恢复已有版本。两类凭据都能读取共享目录数据；创建修订时，请求来源类型必须与认证角色匹配。

维护控制状态只有 `enabled` 和 `paused`。暂停、恢复请求通过 `operation_id` 保证幂等，并用 `expected_generation` 做 CAS 检查。相同请求重放时返回该操作原先产生的控制状态快照，即使当前状态后来已经改变。

发布 extraction 或记忆修订时，先登记发布意图，记录完整结果和文件引用；上传文件后，再由上传方确认这些文件已存在。这里的确认是上传方的声明，并非 Catalog 检查对象存储的结果。正式登记结果时，Catalog 要求提交内容与已确认的发布意图一致，并在同一事务中完成登记和意图选定。

发布中断后，调用方可以查询已记录的意图，用于重试。Catalog 会保留这些记录，但不会自动完成中断的发布，也不会自动清理相关对象。

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
