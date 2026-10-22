# 系统架构

语言：[English](SYSTEM_ARCHITECTURE.md) | 中文

本文是 [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

Sec Review Bot 包含六个运行实体，各自拥有独立的职责和部署边界：GitHub Integration、Review Control Plane、Control Plane UI、Execution Gateway、Execution Worker 和 Memory Catalog Server。

## 运行拓扑

![Sec Review Bot 运行拓扑](../../assets/architecture/runtime-topology.zh.svg)

Temporal Server 属于基础设施，但它直接参与 Execution Gateway 与 Execution Worker 之间的运行关系，因此拓扑图将它与运行服务放在一起。PostgreSQL 和对象存储则单独作为持久化设施呈现。主 review 链路与异步 memory 链路是两条独立流程。

## 主 Review 链路

```mermaid
sequenceDiagram
  participant GitHub
  participant Integration as GitHub Integration
  participant Control as Review Control Plane
  participant Storage as 对象存储
  participant Gateway as Execution Gateway
  participant Temporal
  participant Worker as Execution Worker

  GitHub->>Integration: Webhook 或 Actions 请求
  Integration->>Control: 接纳已校验的 review 请求
  Control-->>Integration: 返回稳定的 run_id
  Integration->>Storage: 发布 input bundle
  Integration->>Control: 提交准备好的 execution input
  Control->>Gateway: 提交 run_id 和 input 引用
  Gateway->>Temporal: 启动 execution
  Temporal->>Worker: 分发 workflow 和 activities
  Worker->>Storage: 读取 input bundle
  loop 直到终态
    Control->>Gateway: 观察 execution
    Gateway-->>Control: 返回当前状态
  end
  Worker-->>Gateway: 返回 workflow result 和 artifact tree
  Gateway->>Storage: 发布终态 artifact
  Gateway-->>Control: 返回 result 和 artifact 引用
  Integration->>Control: 领取 publication 工作
  Control-->>Integration: 返回 result 和 publish context
  Integration->>GitHub: 发布 review 结果
  Integration->>Control: 记录 publication 结果
```

## 异步 Memory 链路

```mermaid
flowchart LR
  records[已完成 review 的过程记录]
  extraction[经验提取]
  observations[待处理 observations]
  maintenance[Memory maintenance]
  versions[不可变 memory revisions]
  active[当前生效的 memory]

  records --> extraction
  extraction --> observations
  observations --> maintenance
  maintenance --> versions
  versions --> active
  active -.供后续 review 读取.-> records
```

## 正常流程

1. GitHub 把 webhook 或 Actions 请求交给 integration。
2. Integration 校验平台请求，并请求 Control Plane 接纳它；接纳请求不携带原始 GitHub webhook payload。
3. Control Plane 创建 run，并将其身份持久化到 PostgreSQL。
4. Control Plane 把稳定的 `run_id` 返回给 integration。状态、artifact、Execution API 请求和日志都使用同一个身份。
5. Integration 准备 input bundle，并使用该 run 身份将其写入对象存储。
6. Integration 向 Control Plane 提交 `publish_context` 和包含 input `ArtifactRef` 的可重放 Execution input；archive 内容仍留在对象存储。
7. Control Plane 在跨越 Execution API 边界前持久化 Execution input，使状态不确定的 submission 可以重放，而不需要重建进程内状态。
8. Control Plane 通过 Execution API 提交 `run_id` 和 input 引用；当前 provider Execution Gateway 负责启动 Temporal workflow。
9. Execution Worker 按引用从对象存储读取 input bundle。
10. Control Plane 轮询 Execution API 的执行状态。
11. Execution Worker 在共享 artifact volume 上完成终态 artifact tree。
12. Execution Gateway 将该目录归档，并把终态 artifact 发布到对象存储。
13. Execution API provider 投影 Temporal 结果，并向 Control Plane 返回 workflow result 和终态 artifact 引用；Control Plane 持久化两者，但不解释 workflow 专用的 result 内容。
14. Integration 领取对应的 publication 工作。Control Plane 返回 workflow result 和该 connector 最初提交的不透明 `publish_context`；`publish_context` 不包含凭据或进程内对象。
15. Integration 发布 GitHub review、comment、issue 或 pull request。
16. Integration 通过 Control Plane 记录发布结果。

时序图和列表展示每一步首次发生的顺序；轮询、heartbeat、重试和状态写入可能重复多次。由于第 3、4 步早于 input 准备，第 5 或第 6 步失败时仍然存在持久化的 `run_id`；只有在接纳前被拒绝的请求没有 `run_id`。

Integration 主动从 Control Plane 领取 publication 工作，而不是等待 Control Plane 回调。Control Plane 将成功终态的工作保持为 `pending`，原子地向 connector 分配 publication claim，并接收 connector 回写的成功或失败结果。因此 GitHub 专用副作用不会进入 Control Plane，integration 重启后也能继续处理未完成工作。

`apps/github-integration/` 负责解析 GitHub 请求、准备 input 和执行 GitHub 发布。`control-plane/` 负责接纳、Execution 协调、恢复和持久化 run 状态。`execution-gateway/` 负责经过鉴权的 HTTP-to-Temporal 边界。`agents/` 负责 Execution Worker、workflow 和 agent runtime。`memory-catalog/` 负责 managed-memory PostgreSQL 状态和 revision 提交。`apps/control-plane-ui/` 读取脱敏的 Control Plane 查询 API，不直接访问 PostgreSQL。

Control Plane 的状态、claim、schema 和 API 细节见 [Control Plane README](../../control-plane/README.zh.md)。
