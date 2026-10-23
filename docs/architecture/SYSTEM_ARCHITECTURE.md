# System Architecture

Sec Review Bot contains seven runtime entities with separate responsibilities and deployment boundaries: GitHub Integration, Review Control Plane, Control Plane UI, Execution Gateway, Execution Worker, Memory Worker, and Memory Catalog Server.

## Runtime topology

![Sec Review Bot runtime topology](../../assets/architecture/runtime-topology.svg)

Temporal Server is infrastructure, but it directly dispatches work to both worker pools, so the topology presents it with the runtime services. PostgreSQL and Object Storage remain separate persistence facilities. The main review path and the asynchronous memory path use separate task queues and worker processes.

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

## Durability and ownership

The diagrams show the first occurrence of each interaction. Polling, heartbeats, retries, and state writes can repeat. Control Plane persists the stable `run_id` before the integration prepares input, so preparation or submission failure still leaves a durable run identity; only a request rejected before admission has no `run_id`. Control Plane also persists replayable Execution input before crossing the Execution API boundary, allowing an uncertain submission to be retried without reconstructing process-local state.

Integration pulls publication work from Control Plane rather than receiving a callback. Control Plane keeps successful terminal work in `pending`, atomically assigns a publication claim to the connector, and accepts the connector's success or failure outcome. This keeps GitHub-specific side effects out of Control Plane while allowing an integration restart to resume unfinished work.

`apps/github-integration/` owns GitHub request parsing, input preparation, and GitHub publication. `control-plane/` owns admission, Execution coordination, recovery, and durable run state. `execution-gateway/` owns the authenticated HTTP-to-Temporal boundary. `agents/` owns both worker processes, their workflows, and the agent runtime. Execution Worker handles review execution and transcript publication; Memory Worker handles extraction and maintenance. `memory-catalog/` owns managed-memory PostgreSQL state and revision commits. `apps/control-plane-ui/` reads the redacted Control Plane query API and never accesses PostgreSQL directly.

Detailed Control Plane state, claim, schema, and API behavior belongs in the [Control Plane README](../../control-plane/README.md).
