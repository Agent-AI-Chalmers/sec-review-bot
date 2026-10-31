# Memory Catalog API

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

[v1/openapi.yaml](v1/openapi.yaml) 是人工维护的 Memory Catalog Server HTTP 边界唯一真值，不由服务代码生成。服务从该文档挂载路由和校验，生成的 TypeScript 投影把服务端与 Control Plane UI 绑定到其中的 operation 和 schema，Python client 的契约测试则校验它发送和消费的 payload。

该契约刻意不包含 PostgreSQL row、Temporal workflow 状态、trajectory 内容和对象存储凭据。

Extraction 与 observation 列表读取使用不透明、排他的 cursor，并采用确定的 newest-first 顺序。调用方使用 `next_cursor` 翻页时必须保持相同过滤条件；cursor 编码属于实现细节。Revision 历史继续使用公开且排他的 `before_revision` cursor，因为 revision number 本身已经是不可变、单调的身份。

Catalog overview 聚合已经完成的 extraction 覆盖情况。单元身份是 `(source_run_id, source_unit_id)`；“未产出 observation”表示该单元至少完成过一次 extraction，但这些 extraction 均未产出 observation。失败或尚未结束的 extraction 不在此视图内。`range` query 可选择 30 天、90 天或全部趋势；`trend_points` 遵循声明的 `trend_granularity`，有限范围按日提供数据点，全部范围按月提供数据点。每个数据点的 `period_start` 是所表示自然日或自然月的 UTC 起始日期（含）。

Memory revision 使用带标签的 `source`：`maintenance` 包含 maintainer identity、被消费的 extraction IDs 和 trajectory reference；`operator` 请求包含幂等 operation ID，持久化 revision 则补充由已认证 operator 凭据推导出的 actor。每个 revision 通过 `predecessor_revision` 记录创建时的 active revision。Restore 是独立的幂等操作，通过 compare-and-swap 把 active pointer 移到已有 revision，不创建 revision。

Worker 凭据用于注册 extraction、读取 maintenance input 和提交 maintenance revision。Operator 凭据用于 pause 或 resume maintenance，并提交人工 revision 或 restore。共享 catalog 读取接受任一凭据；revision 创建会拒绝与已认证角色不匹配的 source kind。

Maintenance control 只提供 `enabled` 与 `paused`。Pause 和 resume 请求使用幂等 `operation_id` 与 `expected_generation` compare-and-swap。相同重放返回原 operation 的结果 control snapshot，即使当前状态后来已经改变。

Publication reserve/confirm endpoints 接受完整 extraction 或 revision 发布意图；list endpoints 按 extraction ID 或 revision source identity 恢复 发布意图。确认表示已认证 producer 声明所有引用对象都已存在。正式挂接要求精确匹配已确认的 发布意图，并在事务内选中它。Revision publication endpoints 执行与 revision 创建一致的 worker/operator source 角色限制。Extraction 恢复会同时保留 summary 和完整 registration payload。Candidate 保留用于恢复和检查；API 不表示会删除对象或自动执行 reconciliation。

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
