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
| Execution Worker | `agents/` | Review workflows, activities, agent runtime, stage artifacts, and transcript publication | [README](../../agents/README.md) |
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
  ExecutionWorker-->>Gateway: Workflow result and artifact tree
  Gateway->>Storage: Publish terminal artifact
  Gateway-->>Control: Result and artifact reference
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

  ExecutionWorker->>Storage: Publish completed-review transcripts
  ExecutionWorker->>Temporal: Request asynchronous memory processing
  Temporal->>MemoryWorker: Dispatch memory extraction work
  MemoryWorker->>Storage: Read transcript bundle and publish audit bundle
  MemoryWorker->>Catalog: Register pending observation
  loop Scheduled memory maintenance
    Temporal->>MemoryWorker: Dispatch maintenance work
    MemoryWorker->>Catalog: Read pending observations and active revision
    Catalog-->>MemoryWorker: Observations and active revision reference
    MemoryWorker->>Storage: Read active memory and publish immutable revision
    MemoryWorker->>Catalog: Commit revision and active pointer with compare-and-swap
  end
```

## State and recovery boundaries

| Durable state | Owner | Purpose |
| --- | --- | --- |
| Run admission, replayable execution input, execution observation, and publication progress | Review Control Plane in PostgreSQL | Coordination and recovery across service restarts |
| Workflow and activity history | Temporal Server | Durable scheduling, retries, timeouts, and workflow recovery |
| Input bundles, terminal artifacts, transcripts, audit bundles, and memory revisions | Object Storage | Immutable exchange and archival of large artifacts |
| Memory observations and the active revision pointer | Memory Catalog Server in PostgreSQL | Catalog coordination and compare-and-swap revision activation |

These stores are independent recovery inputs. Missing Temporal history does not establish a publication outcome, and a PostgreSQL run record does not imply that its referenced object still exists. Recovery must reconcile the owner of each state rather than infer one subsystem's outcome from another subsystem.

An external side effect is complete only when the component that owns its coordination state records the outcome. Component-specific state machines and retry rules belong in the owning package README; cross-component data shapes belong in the relevant contract family.
