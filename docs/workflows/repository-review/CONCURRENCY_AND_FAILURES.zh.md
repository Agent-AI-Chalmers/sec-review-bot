# Repository Review 并发与失败边界

语言：[English](CONCURRENCY_AND_FAILURES.md) | 中文

本文是 [CONCURRENCY_AND_FAILURES.md](CONCURRENCY_AND_FAILURES.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

这份文档说明 `repository-review` 如何使用阶段内并发、哪些调参入口影响墙钟时间，以及失败如何被边界收住。

App 提交的 runs、workflow fanout 和 worker activity 容量之间的系统级并发关系，见
[../CONCURRENCY_MODEL.zh.md](../CONCURRENCY_MODEL.zh.md)。本文只聚焦一个 repository run
被接收后，repository review workflow 内部的并发与失败边界。

## 总览

`repository-review` 里有几类并发：

- discovery 可以并发处理 chunks。
- triage 可以并发处理 batch drafts。
- case processing 可以并发处理 cases。
- 单个 case 内部，CVSS scoring 可以和 mitigation / verification 路径重叠执行。
- delivery planning 可以并发处理 batch drafts。
- delivery execution 可以并发处理 combined deliveries。

## 滑动窗口

本文讨论的 repository review 阶段内并发都按滑动窗口理解。

滑动窗口并发的意思是：最多保持 N 个任务在飞；任意一个任务完成后，立即补下一个任务。

```text
先启动最多 N 个任务
某个任务完成
启动下一个排队任务
重复直到队列为空
```

这不同于固定批次。固定批次会等整批结束后再启动下一批；滑动窗口能减少任务耗时不均时的空档。

以下面两种 case workflow 的并发图为例，并发数都是 `3`，但是调度方式不同。固定批次会等一整组跑完后再启动下一组。

> *本节的 timeline 截图仅用于说明调度形态和执行顺序；图中的 workflow / activity 名称可能来自旧运行或早期命名，不代表当前 API 名称。*

![固定批次的 repository case workflow timeline](../../../assets/screenshots/repository-case-fixed-batch-timeline.png)

滑动窗口则不等整组结束；只要有空位，后续 case 就会补进来。

![滑动窗口的 repository case workflow timeline](../../../assets/screenshots/repository-case-sliding-window-timeline.png)

*读图时看每条 case 横条的左端点：长横条只是运行时间更长的 case；其他空位释放后，后续 case 仍会立刻启动。*

## 阶段细节

### Discovery

Discovery 会把仓库文件打成 chunks。Temporal 路径和 direct 路径都会按滑动窗口执行 discovery chunks。

并发上限来自 `AGENT_DISCOVERY_MAX_CONCURRENCY`，默认是 `1`。实际有效并发不会超过 chunk 数。

在 Temporal 路径里，每个 discovery chunk 是一个 activity，会走 Temporal activity retry。retry 之后仍失败时，整个 discovery 失败。Discovery 不合成 partial completed result，因为缺一个 chunk 就意味着扫描覆盖不完整。

### Triage

Triage 在一个 activity 内部运行。batched triage 会按滑动窗口执行 batch drafts，然后进入全局 refinement / workbench state。

当前 batch draft 并发上限是代码常量 `TRIAGE_MAX_BATCH_CONCURRENCY = 3`。这不是常规部署环境变量。Triage 的输出是全局 case set；某个 batch 失败时，整个 triage 失败。

### Case Processing

Triage 后的每个 case 是独立审查单元。Repository review 会按滑动窗口执行 case workflows。

并发上限来自 `AGENT_CASE_PROCESSING_MAX_CONCURRENCY`，默认是 `1`。实际有效并发不会超过 case 数。

单个 case workflow 内部也有并行。Temporal 时间线里，CVSS scoring 可以和 mitigation / verification 路径重叠执行：

![单个 repository case workflow 的 Temporal timeline](../../../assets/screenshots/repository-case-stage-timeline.png)

如果单个 case 在 activity retry 后仍失败，repository review 会记录 blocked case result，其他 case 继续执行。

### Delivery Planning

Delivery planning 可以按滑动窗口执行 batch drafts，然后进入全局 refinement / workbench state。

当前 batch draft 并发上限是代码常量 `DELIVERY_PLANNING_MAX_BATCH_CONCURRENCY = 3`。这不是常规部署环境变量。Delivery planning 产出的是全局 delivery plan；某个 batch 失败时，整个 delivery planning 失败。

### Delivery Execution

Delivery execution 只消费 `disposition == "keep"` 的 case。

`single` delivery 不调用 agent，不进入 patch synthesis 并发池。它直接投影 case 级 `review_record.mitigation.file_changes`。

`combined` delivery 会调用 patch-synthesis agent。多个 combined deliveries 会按滑动窗口执行。

并发上限来自 `REPOSITORY_PATCH_SYNTHESIS_MAX_CONCURRENCY`，默认是 `4`。

Temporal 路径里，combined delivery patch synthesis 是独立 activity；`single` delivery 仍然是轻量投影，不占 patch synthesis 并发窗口。Direct 路径仍然在本地进程内用滑动窗口执行。

如果某个 combined delivery 的 patch synthesis 失败，其他 deliveries 继续执行。public `deliveries[]` 只包含成功 delivery。失败的 synthesis 排障看运行日志。

## 调参顺序

通常最值得先调的是 `AGENT_CASE_PROCESSING_MAX_CONCURRENCY`。Case processing 通常占据最长的墙钟窗口，而且 analyzer / mitigator / verifier 都可能是 LLM-heavy 或 sandbox-heavy。

第二个常见杠杆是 `REPOSITORY_PATCH_SYNTHESIS_MAX_CONCURRENCY`。它只影响 `combined` delivery 的 patch synthesis。它不会改变 delivery 边界，也不会把不同 deliveries 合并成一个最终 patch。

Discovery 是否值得调，取决于 chunk 数和单个 chunk 的耗时。如果仓库只形成一个 chunk，提高 `AGENT_DISCOVERY_MAX_CONCURRENCY` 没有意义。如果 chunk 很多，调高 discovery 并发可以减少 discovery 的墙钟时间。

---

Temporal 部署还有一个 worker 侧 activity executor 线程池：`TEMPORAL_ACTIVITY_WORKERS`。上面的 workflow 并发配置控制 workflow 最多允许多少任务同时在飞。`TEMPORAL_ACTIVITY_WORKERS` 控制单个 worker 同时执行多少 activity。如果这个池太小，workflow 已经调度出去的 activity 仍然会在 worker 侧排队。

## 资源限制

并发上升后，首先可能触及本地资源上限。例如同时运行过多 analyzer / mitigator / verifier containers，可能让 CPU、内存、网络或磁盘 IO 成为瓶颈。

LLM 服务商限制也会变得更明显，例如 TPM、RPM 或瞬时并发请求限制。

并发数本身不等于 TPM。TPM 取决于单位时间内实际发出的 token 速率，而这又受到任务类型、请求频率、单次请求 token 规模和 agent 行为模式影响。

会出现两种情况：

- 有些任务并发高，但每个任务请求稀疏、token 少，TPM 并不高。
- 有些任务并发低，但每个任务吃大上下文、连续多轮对话，TPM 很快打满。

所以并发上限不能只靠直觉决定，需要结合 workload 形状和实测结果。

常见解决办法是增加资源：

- 更多本地 CPU / memory / IO
- 更高 LLM 总预算
- 更高 TPM / RPM 的 LLM API
- 多个 LLM API 来源分担负载
- 更大的 Temporal activity worker pool

## 观测例子

下面是一次 repository review 的近似观测，用来说明 case processing 并发的影响。

| Run | Case 并发 | 总时长 | Discovery | Triage | Case processing | Delivery planning | Patch synthesis |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 3 | 49 分 46.8 秒 | 0 分 42 秒，约 1.4% | 4 分 30 秒，约 9.0% | 约 32 分 44 秒，约 65.8% | 2 分 29 秒，约 5.0% | 约 9 分 20 秒，约 18.8% |
| B | 6 | 31 分 21 秒 | 5 分 46 秒，约 18.4% | 4 分 33 秒，约 14.5% | 约 15 分 10 秒，约 48.7% | 2 分 38 秒，约 8.4% | 约 3 分 12 秒，约 10.2% |
| C | 8 | 32 分 19 秒 | 1 分 58 秒，约 6.1% | 3 分 23 秒，约 10.5% | 约 18 分 51 秒，约 58.3% | 3 分 13 秒，约 9.9% | 约 4 分 54 秒，约 15.2% |

- 并发从 `3` 提到 `6` 后，总时长显著下降；最关键变化是中段 case processing 被明显压缩。
- 并发从 `6` 提到 `8` 后，总时长没有继续下降，反而从 **31 分 21 秒** 变为 **32 分 19 秒**，大约多了 **58 秒**。这说明在这组 workload 下，case 并发继续升高已经没有明显收益，系统开始更多受到单 case 长尾、阶段波动和其他资源瓶颈影响。
