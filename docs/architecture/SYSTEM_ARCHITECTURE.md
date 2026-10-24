# System Architecture

Sec Review Bot contains seven runtime entities with separate responsibilities and deployment boundaries: GitHub Integration, Review Control Plane, Control Plane UI, Execution Gateway, Execution Worker, Memory Worker, and Memory Catalog Server.

## Runtime topology

![Sec Review Bot runtime topology](../../assets/architecture/runtime-topology.svg)

Temporal Server is infrastructure, but it directly dispatches work to both worker pools, so the topology presents it with the runtime services. PostgreSQL and Object Storage remain separate persistence facilities. The main review path and the asynchronous memory path use separate task queues and worker processes.

## Runtime ownership map

| Runtime entity | Code | Owns | Local guide |
| --- | --- | --- | --- |
| GitHub Integration | `apps/github-integration/` | GitHub ingress, input preparation, Control Plane client, and GitHub publication | [README](../../apps/github-integration/README.md) |
| Review Control Plane | `control-plane/` | Admission, durable run state, recovery, execution observation, and publication coordination | [README](../../control-plane/README.md) |
| Control Plane UI | `apps/control-plane-ui/` | Authenticated operator console and read-only Control Plane projection | [README](../../apps/control-plane-ui/README.md) |
| Execution Gateway | `execution-gateway/` | Authenticated Execution API and HTTP-to-Temporal translation | [README](../../execution-gateway/README.md) |
| Execution Worker | `agents/` | Review workflows, activities, agent runtime, stage artifacts, and run diagnostic publication | [README](../../agents/README.md) |
| Memory Worker | `agents/` | Asynchronous memory extraction and maintenance workflows | [README](../../agents/README.md) |
| Memory Catalog Server | `memory-catalog/` | Observation catalog, immutable memory revision history, and active revision coordination | [README](../../memory-catalog/README.md) |

The runtime entities communicate through project-owned boundaries under [`contracts/`](../../contracts/README.md). Package location does not imply shared runtime ownership: the two workers are separate processes even though they are implemented in the same Python package, while the two applications under `apps/` are independently deployed services.

## Main review path

```mermaid
sequenceDiagram
  participant GitHub
  participant Integration as GitHub Integration
  participant Control as Review Control Plane
  participant Storage as Object Storage
  participant Gateway as Execution Gateway
  participant Temporal as Temporal Server
  participant ExecutionWorker as Execution Worker

  GitHub->>Integration: Webhook or Actions request
  Integration->>Control: Admit validated review request
  Control-->>Integration: Stable run_id
  Integration->>Storage: Publish input bundle
  Integration->>Control: Submit prepared execution input
  Control->>Gateway: Submit run_id and input reference
  Gateway->>Temporal: Start execution
  Temporal->>ExecutionWorker: Dispatch workflow and activities
  ExecutionWorker->>Storage: Read input bundle
  loop Until terminal
    Control->>Gateway: Observe execution
    Gateway-->>Control: Current status
  end
  ExecutionWorker->>Storage: Publish run diagnostic bundle
  ExecutionWorker-->>Gateway: Workflow result and diagnostic reference
  Gateway-->>Control: Result and diagnostic reference
  Integration->>Control: Claim publication work
  Control-->>Integration: Result and publish context
  Integration->>GitHub: Publish review output
  Integration->>Control: Record publication outcome
```

## Asynchronous memory path

```mermaid
sequenceDiagram
  participant Temporal as Temporal Server
  participant ExecutionWorker as Execution Worker
  participant MemoryWorker as Memory Worker
  participant Catalog as Memory Catalog Server
  participant Storage as Object Storage

  ExecutionWorker->>Temporal: Request asynchronous memory processing
  Temporal->>MemoryWorker: Dispatch memory extraction work
  MemoryWorker->>Storage: Read review transcripts from run diagnostic bundle
  Note over MemoryWorker: Extract memory and record Memory Agent transcripts
  MemoryWorker->>Storage: Publish Memory Agent audit bundle
  MemoryWorker->>Catalog: Register pending observation
  loop Scheduled memory maintenance
    Temporal->>MemoryWorker: Dispatch maintenance work
    MemoryWorker->>Catalog: Read pending observations and active revision
    Catalog-->>MemoryWorker: Observations and active revision reference
    MemoryWorker->>Storage: Read active memory and publish immutable revision
    MemoryWorker->>Catalog: Commit revision and active pointer with compare-and-swap
  end
```
