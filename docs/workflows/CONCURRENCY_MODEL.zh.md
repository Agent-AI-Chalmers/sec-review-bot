# Workflow 并发模型

语言：[English](CONCURRENCY_MODEL.md) | 中文

本文为 [CONCURRENCY_MODEL.md](CONCURRENCY_MODEL.md) 的中文译文；如有差异，以英文版为准。

本文说明系统级并发层次：run、workflow 和 activity 如何共享容量。repository-review 阶段内部的并发另见 [CONCURRENCY_AND_FAILURES](repository-review/CONCURRENCY_AND_FAILURES.zh.md)。

## Temporal 基本术语

| 术语               | 含义                                                                              |
| ------------------ | --------------------------------------------------------------------------------- |
| workflow           | 定义任务编排的代码，负责安排 activity、启动 child workflow 和处理执行结果。       |
| workflow execution | 一个 workflow 的一次具体执行，Temporal 保存其执行历史。                           |
| child workflow     | 由另一个 workflow 启动的子 workflow，例如仓库审查中各 case 的处理。               |
| activity           | 执行具体工作的单元，例如运行 Analyzer；一次执行失败后可按重试策略再次尝试。       |
| workflow task      | Worker 推进 workflow 编排的一次任务，例如处理 activity 完成事件并安排下一步。     |
| Worker             | 轮询 task queue、执行 workflow task 或 activity task 的进程。                     |
| task queue         | Temporal 向 Worker 分发 workflow task 或 activity task 的队列。                   |
| activity slot      | Worker 同时执行 activity 的空位。例如有 8 个 slot，就最多同时执行 8 个 activity。 |

## 层次

并发分三层控制：

- App 提交的 run：每个 run 会启动独立的 Temporal workflow execution，不同 run 可以同时推进。
- Workflow 内部并发：一个 workflow 可以通过滑动窗口，同时推进多个 child workflow 或 activity。
- Worker activity 容量：每个 Worker 进程都有 activity 并发上限。

这三层相互影响，但各自单独控制。

## Run 不是 activity slot

Execution Gateway 会为 App 提交的 run 启动 Temporal workflow。Temporal 不会把一个完整 run 当成一个 Worker slot。一个 run 会被拆成 workflow task、activity task，有时还有 child workflow。

<!-- doc-default: TEMPORAL_MEMORY_MAINTENANCE_MAX_CONCURRENT_ACTIVITIES; source=agents/src/sec_review_agents/entrypoints/memory_maintenance_worker/main.py -->

| 配置项                                                  | 对应 Worker               | 限制内容                                  |
| ------------------------------------------------------- | ------------------------- | ----------------------------------------- |
| `TEMPORAL_EXECUTION_MAX_CONCURRENT_ACTIVITIES`          | Execution Worker          | 每个进程同时执行的 review activity 数量。 |
| `TEMPORAL_MEMORY_EXTRACTION_MAX_CONCURRENT_ACTIVITIES`  | Memory Extraction Worker  | 每个进程同时执行的 activity 数量。        |
| `TEMPORAL_MEMORY_MAINTENANCE_MAX_CONCURRENT_ACTIVITIES` | Memory Maintenance Worker | 同时执行的 activity 数量，固定为 `1`。    |

这些配置限制同时执行的 activity 数量，不限制已提交但尚未结束的 run 数量。多个 run 共享 Worker 的 activity 容量，具体分配见下例。

Execution 与 memory extraction 可以通过增加轮询各自队列的 Worker 进程来扩容。Memory maintenance 则刻意不同：集成部署只运行一个非 template service，并固定为一个 activity slot，不支持增加维护 Worker 进程来扩容。

例如 `TEMPORAL_EXECUTION_MAX_CONCURRENT_ACTIVITIES=8` 时：

```text
run-1 当前有 3 个 activities 正在执行
run-2 当前有 4 个 activities 正在执行
run-3 当前有 1 个 activity 正在执行
=> 该 Worker 的 activity 并发名额已用满
```

这些数字是某一刻的 activity 使用量，run 没有固定保留的槽位。线性的 issue review 通常同一时间只占一个主要 activity；repository review 可能展开 chunks、cases 或 delivery work，因此消耗更多 activity 容量。

## Temporal task queue

Temporal task queue 是 workflow task 和 activity task 的执行队列。它不是业务意义上提交的 review run 的 FIFO 队列。

多个 Worker 可以轮询同一个 task queue。Worker 有容量时，就可以继续领取 activity task。App 提交 run 的顺序不保证等于完成顺序。

如果产品需要严格的 run 级 admission control，应显式建模，例如 dispatcher workflow、service 层队列，或持久化 run table。不要用 activity slots 去解释 run 级公平性。

## Workflow 内部并发

有些 workflow 会控制自己的内部并发。Repository review 是主要例子：

- discovery 可以同时调度多个 chunk activity；
- case processing 可以同时推进多个 case child workflow；
- delivery execution 可以同时调度多个 combined delivery activity。

这些 workflow 级窗口限制单个 run 能展开到多大。底层仍然受 Worker activity 容量限制：如果所有 Worker 的 activity 并发名额均已用满，workflow 已经调度出去的 activity 仍会在 Temporal 侧等待，直到有 Worker 可以执行。
