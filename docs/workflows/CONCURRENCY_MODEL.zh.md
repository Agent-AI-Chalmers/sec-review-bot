# Workflow 并发模型

语言：[English](CONCURRENCY_MODEL.md) | 中文

本文说明系统级并发层次：run、workflow 和 activity 如何共享容量。
repository-review 阶段内部的并发另见
[repository-review/CONCURRENCY_AND_FAILURES.zh.md](repository-review/CONCURRENCY_AND_FAILURES.zh.md)。

## 层次

并发分三层控制：

- App 提交的 runs：每个提交的 run 会启动一个独立的 Temporal workflow execution。不同 run 可以同时推进。
- Workflow 内部 fanout：一个 workflow 可以有意保持多个 child workflows 或 activities 在飞，通常用滑动窗口。
- Worker activity 容量：一个 worker 进程同一时间只能执行有限数量的 activities。

这三层有关联，但不是同一个开关。

## Run 不是 activity slot

Runner service 会为 app 提交的 run 启动 Temporal workflow。Temporal 不会把一个完整 run 当成一个 worker slot。一个 run 会被拆成 workflow tasks、activity tasks，有时还有 child workflows。

`TEMPORAL_ACTIVITY_WORKERS` 控制 worker 侧 activity executor 大小。它的意思是“这个 worker 进程同时能执行多少个 activities”，不是“允许多少个 app 提交的 runs 处于 active”。

例如 `TEMPORAL_ACTIVITY_WORKERS=8` 时：

```text
run-1 当前有 3 个 activities 正在执行
run-2 当前有 4 个 activities 正在执行
run-3 当前有 1 个 activity 正在执行
=> worker activity pool 被占满
```

这些数字只是某一刻的 activity 使用量，不是每个 run 固定保留的槽位。线性的 issue review 通常同一时间只占一个主要 activity；repository review 可能展开 chunks、cases 或 delivery work，因此消耗更多 activity 容量。

## Temporal task queues

Temporal task queue 是 workflow tasks 和 activity tasks 的执行队列。它不是业务意义上“提交的 review runs 的 FIFO 队列”。

多个 workers 可以 poll 同一个 task queue。worker 有容量时，就可以继续拿 activity tasks。App 提交 run 的顺序不保证等于完成顺序。

如果产品需要严格的 run 级 admission control，应显式建模，例如 dispatcher workflow、service 层队列，或持久化 run table。不要用 activity slots 去解释 run 级公平性。

## Workflow fanout

有些 workflow 会控制自己的内部 fanout。Repository review 是主要例子：

- discovery 可以保持多个 chunk activities 在飞；
- case processing 可以保持多个 case child workflows 在飞；
- delivery execution 可以保持多个 combined delivery activities 在飞。

这些 workflow 级窗口限制单个 run 能展开到多大。底层仍然受 worker activity 容量限制：如果 worker pool 已满，workflow 已经调度出去的 activities 仍会在 Temporal 侧等待，直到有 worker 可以执行。
