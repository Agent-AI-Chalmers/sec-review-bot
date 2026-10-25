# System Architecture

Sec Review Bot has eight runtime roles: GitHub Integration, Review Control Plane, Control Plane UI, Execution Gateway, Execution Worker, Memory Extraction Worker, Memory Maintenance Worker, and Memory Catalog Server.

## Runtime topology

![Sec Review Bot runtime topology](../../assets/architecture/runtime-topology.svg)

Temporal Server is infrastructure, but it directly dispatches work to the worker processes, so the topology presents it with the runtime services. PostgreSQL and Object Storage remain separate persistence facilities. Review execution, memory extraction, and memory maintenance use independent worker processes and task queues.

## Runtime ownership map

| Runtime role | Code | Owns | Local guide |
| --- | --- | --- | --- |
| GitHub Integration | `apps/github-integration/` | GitHub ingress, input preparation, Control Plane client, and GitHub publication | [README](../../apps/github-integration/README.md) |
| Review Control Plane | `control-plane/` | Admission, durable run state, recovery, execution observation, and publication coordination | [README](../../control-plane/README.md) |
| Control Plane UI | `apps/control-plane-ui/` | Authenticated operator console and read-only Control Plane projection | [README](../../apps/control-plane-ui/README.md) |
| Execution Gateway | `execution-gateway/` | Authenticated Execution API and HTTP-to-Temporal translation | [README](../../execution-gateway/README.md) |
| Execution Worker | `agents/` | Review workflows, activities, agent runtime, stage artifacts, and run diagnostic publication | [README](../../agents/README.md) |
| Memory Extraction Worker | `agents/` | Per-run diagnostic consumption, extractor invocation, transcript publication, and extraction registration | [README](../../agents/README.md) |
| Memory Maintenance Worker | `agents/` | Bounded maintenance input consumption, maintainer invocation, memory tree publication, and revision commit | [README](../../agents/README.md) |
| Memory Catalog Server | `memory-catalog/` | Observation catalog, immutable memory revision history, and active revision coordination | [README](../../memory-catalog/README.md) |

The runtime roles communicate through project-owned boundaries under [`contracts/`](../../contracts/README.md). Package location does not determine process topology: `agents/` implements three independent Temporal workers. The two applications under `apps/` remain independently deployed services.

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
  participant ExtractionWorker as Memory Extraction Worker
  participant MaintenanceWorker as Memory Maintenance Worker
  participant Catalog as Memory Catalog Server
  participant Storage as Object Storage

  ExecutionWorker->>Temporal: Request asynchronous memory processing
  Temporal->>ExtractionWorker: Dispatch memory extraction work
  ExtractionWorker->>Storage: Fetch run diagnostic bundle
  Storage-->>ExtractionWorker: Run diagnostic bundle with review transcripts
  Note over ExtractionWorker: Run extractor and record extractor invocation transcript
  ExtractionWorker->>Storage: Publish compressed extractor transcript
  ExtractionWorker->>Catalog: Atomically register extraction, transcript reference, and optional observation
  loop Scheduled memory maintenance
    Temporal->>MaintenanceWorker: Dispatch maintenance work
    Note over Temporal,MaintenanceWorker: One fixed workflow ID permits only one maintainer
    MaintenanceWorker->>Catalog: Read bounded maintenance input
    Catalog-->>MaintenanceWorker: Observations with extraction IDs, base revision, and active memory tree reference
    opt Active memory tree exists
      MaintenanceWorker->>Storage: Fetch active memory tree artifact
      Storage-->>MaintenanceWorker: Memory tree artifact
      Note over MaintenanceWorker: Materialize active memory tree
    end
    Note over MaintenanceWorker: Run maintainer and record maintainer invocation transcript
    MaintenanceWorker->>Storage: Publish compressed maintainer transcript
    MaintenanceWorker->>Storage: Publish new memory tree artifact
    MaintenanceWorker-->>Temporal: Artifact references, consumed extraction IDs, and base revision
    Note over Temporal: Persist the prepared commit input in workflow history
    Temporal->>MaintenanceWorker: Dispatch revision commit with the recorded input
    MaintenanceWorker->>Catalog: Create memory tree revision with maintenance ID and base-revision CAS
    Catalog-->>MaintenanceWorker: Created or idempotently replayed revision, or revision conflict
  end
```
