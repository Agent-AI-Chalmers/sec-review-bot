# 系统架构

语言：[English](SYSTEM_ARCHITECTURE.md) | 中文

本文是 [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

Sec Review Bot 包含八个运行角色：GitHub Integration、Review Control Plane、Control Plane UI、Execution Gateway、Execution Worker、Memory Extraction Worker、Memory Maintenance Worker 和 Memory Catalog Server。

## 运行拓扑

![Sec Review Bot 运行拓扑](../../assets/architecture/runtime-topology.zh.svg)

Temporal Server 属于基础设施，但它会直接向 worker 进程分发工作，因此拓扑图将它与运行服务放在一起。PostgreSQL 和对象存储则单独作为持久化设施呈现。Review execution、memory extraction 与 memory maintenance 分别使用独立的 worker 进程和 task queue。

## 运行角色职责地图

| 运行角色 | 代码 | 负责内容 | 本地指南 |
| --- | --- | --- | --- |
| GitHub Integration | `apps/github-integration/` | GitHub 入口、input 准备、Control Plane client 与 GitHub publication | [README](../../apps/github-integration/README.zh.md) |
| Review Control Plane | `control-plane/` | 接纳、持久化 run 状态、恢复、execution 观察与 publication 协调 | [README](../../control-plane/README.zh.md) |
| Control Plane UI | `apps/control-plane-ui/` | 经过鉴权的运维控制台与只读 Control Plane 投影 | [README](../../apps/control-plane-ui/README.md) |
| Execution Gateway | `execution-gateway/` | 经过鉴权的 Execution API 与 HTTP-to-Temporal 转换 | [README](../../execution-gateway/README.zh.md) |
| Execution Worker | `agents/` | Review workflow、activity、agent runtime、stage artifact 与 run diagnostic publication | [README](../../agents/README.zh.md) |
| Memory Extraction Worker | `agents/` | 按 run 消费 diagnostic、调用 extractor、发布 transcript 并登记 extraction | [README](../../agents/README.zh.md) |
| Memory Maintenance Worker | `agents/` | 消费有界 maintenance input、调用 maintainer、发布 memory tree 并提交 revision | [README](../../agents/README.zh.md) |
| Memory Catalog Server | `memory-catalog/` | Observation catalog、不可变 memory revision history 与 active revision 协调 | [README](../../memory-catalog/README.zh.md) |

这些运行角色通过 [`contracts/`](../../contracts/README.zh.md) 下由项目维护的边界通信。Package 位置并不决定进程拓扑：`agents/` 实现三个独立的 Temporal worker。`apps/` 下的两个应用则仍分别独立部署。

## 主 Review 链路

```mermaid
sequenceDiagram
  participant GitHub
  participant Integration as GitHub Integration
  participant Control as Review Control Plane
  participant Storage as 对象存储
  participant Gateway as Execution Gateway
  participant Temporal as Temporal Server
  participant ExecutionWorker as Execution Worker

  GitHub->>Integration: Webhook 或 Actions 请求
  Integration->>Control: 接纳已校验的 review 请求
  Control-->>Integration: 返回稳定的 run_id
  Integration->>Storage: 发布 input bundle
  Integration->>Control: 提交准备好的 execution input
  Control->>Gateway: 提交 run_id 和 input 引用
  Gateway->>Temporal: 启动 execution
  Temporal->>ExecutionWorker: 分发 workflow 和 activities
  ExecutionWorker->>Storage: 读取 input bundle
  loop 直到终态
    Control->>Gateway: 观察 execution
    Gateway-->>Control: 返回当前状态
  end
  ExecutionWorker->>Storage: 发布 run diagnostic bundle
  ExecutionWorker-->>Gateway: 返回 workflow result 和 diagnostic 引用
  Gateway-->>Control: 返回 result 和 diagnostic 引用
  Integration->>Control: 领取 publication 工作
  Control-->>Integration: 返回 result 和 publish context
  Integration->>GitHub: 发布 review 结果
  Integration->>Control: 记录 publication 结果
```

## 异步 Memory 链路

```mermaid
sequenceDiagram
  participant Temporal as Temporal Server
  participant ExecutionWorker as Execution Worker
  participant ExtractionWorker as Memory Extraction Worker
  participant MaintenanceWorker as Memory Maintenance Worker
  participant Catalog as Memory Catalog Server
  participant Storage as 对象存储

  ExecutionWorker->>Temporal: 请求异步 memory 处理
  Temporal->>ExtractionWorker: 分发 memory extraction 工作
  ExtractionWorker->>Storage: 获取 run diagnostic bundle
  Storage-->>ExtractionWorker: 返回包含 review transcripts 的 run diagnostic bundle
  Note over ExtractionWorker: 运行 extractor 并记录 extractor invocation transcript
  ExtractionWorker->>Storage: 发布压缩后的 extractor transcript
  ExtractionWorker->>Catalog: 原子登记 extraction、transcript reference 和可选 observation
  loop 定期 memory maintenance
    Temporal->>MaintenanceWorker: 分发 maintenance 工作
    Note over Temporal,MaintenanceWorker: 固定 workflow ID 确保同一时间只有一个 maintainer
    MaintenanceWorker->>Catalog: 读取有界 maintenance input
    Catalog-->>MaintenanceWorker: 返回带 extraction IDs 的 observations、base revision 和 active memory tree reference
    opt 存在 active memory tree
      MaintenanceWorker->>Storage: 获取 active memory tree artifact
      Storage-->>MaintenanceWorker: 返回 memory tree artifact
      Note over MaintenanceWorker: 物化 active memory tree
    end
    Note over MaintenanceWorker: 运行 maintainer 并记录 maintainer invocation transcript
    MaintenanceWorker->>Storage: 发布压缩后的 maintainer transcript
    MaintenanceWorker->>Storage: 发布新的 memory tree artifact
    MaintenanceWorker-->>Temporal: 返回 artifact references、consumed extraction IDs 和 base revision
    Note over Temporal: 将待提交内容持久化到 workflow history
    Temporal->>MaintenanceWorker: 使用已记录内容调度 revision 提交
    MaintenanceWorker->>Catalog: 使用 maintenance ID 和 base revision CAS 创建 memory tree revision
    Catalog-->>MaintenanceWorker: 返回新建或幂等重放的 revision，或 revision conflict
  end
```
