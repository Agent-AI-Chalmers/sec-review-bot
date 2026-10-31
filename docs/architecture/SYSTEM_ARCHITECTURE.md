# System Architecture

Language: English | [中文](SYSTEM_ARCHITECTURE.zh.md)

Sec Review Bot's repository-owned runtime roles are GitHub Integration, Review Runs, Control Plane UI, Execution Gateway, Execution Worker, Memory Extraction Worker, Memory Maintenance Worker, and Memory Catalog Server. Langfuse is a trusted observability dependency with an independent deployment and lifecycle, not a repository-owned runtime role.

## Runtime topology

![Sec Review Bot runtime topology](../../assets/architecture/runtime-topology.svg)

Temporal Server is infrastructure, but it directly dispatches work to the worker processes, so the topology presents it with the runtime services. PostgreSQL and Object Storage remain separate persistence facilities. Langfuse appears outside the repository deployment boundary: workers optionally export LLM observations to it, and Review Runs reads those observations asynchronously to persist model-usage snapshots. Review execution, memory extraction, and memory maintenance use independent worker processes and task queues.

The memory path has one deployment-independent state model. Memory Catalog owns coordination state in PostgreSQL, Object Storage owns immutable memory-tree and trajectory artifacts, and Temporal owns workflow execution. Each review invocation materializes the current memory tree into a temporary directory for its agent backend and removes that directory afterward.

Control Plane UI manages Memory Catalog through its BFF and never exposes Catalog tokens, storage credentials, or `s3://` references to the browser. The BFF fetches and identity-checks artifact downloads. Authenticated operators can pause or resume automatic maintenance, create operator edit revisions, and restore the active pointer to an existing revision. New revisions retain that active revision as their predecessor while revision identities remain globally increasing. The BFF can create immutable memory-tree objects, while run artifacts and memory trajectories remain read-only.

## Runtime ownership map

| Runtime role | Code | Owns | Local guide |
| --- | --- | --- | --- |
| GitHub Integration | `apps/github-integration/` | GitHub ingress, input preparation, Review Runs client, and GitHub publication | [README](../../apps/github-integration/README.md) |
| Review Runs | `services/review-runs/` | Admission, durable run state, recovery, execution observation, and publication coordination | [README](../../services/review-runs/README.md) |
| Control Plane UI | `apps/control-plane-ui/` | Authenticated operator console for Review Runs inspection and memory management | [README](../../apps/control-plane-ui/README.md) |
| Execution Gateway | `services/execution-gateway/` | Authenticated Execution API and HTTP-to-Temporal translation | [README](../../services/execution-gateway/README.md) |
| Execution Worker | `agents/` | Review workflows, activities, agent runtime, stage artifacts, and run diagnostic publication | [README](../../agents/README.md) |
| Memory Extraction Worker | `agents/` | Per-run diagnostic consumption, extractor invocation, trajectory publication, and extraction registration | [README](../../agents/README.md) |
| Memory Maintenance Worker | `agents/` | Batched maintenance input consumption, maintainer invocation, memory tree publication, and revision commit | [README](../../agents/README.md) |
| Memory Catalog Server | `services/memory-catalog/` | Observation catalog, immutable memory revision history, and active revision coordination | [README](../../services/memory-catalog/README.md) |

The runtime roles communicate through project-owned boundaries under [`contracts/`](../../contracts/README.md). `services/` groups the internal HTTP service packages; each retains its own configuration, build, and deployment. Package location does not determine process topology: `agents/` implements independently deployed Temporal workers. Applications under `apps/` remain independently deployed services.

## Main review path

```mermaid
sequenceDiagram
  participant GitHub
  participant Integration as GitHub Integration
  participant Control as Review Runs
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
  ExtractionWorker->>Storage: Download run diagnostic bundle
  Storage-->>ExtractionWorker: Run diagnostic bundle
  Note over ExtractionWorker: Read review trajectories and run extractor
  ExtractionWorker->>Storage: Store extractor trajectory
  ExtractionWorker->>Catalog: Save extraction result, trajectory reference, and observation (if any) in one transaction
  loop Scheduled memory maintenance
    Temporal->>MaintenanceWorker: Dispatch maintenance work
    Note over Temporal,MaintenanceWorker: One fixed workflow ID permits only one maintainer
    MaintenanceWorker->>Catalog: Select a batch of pending observations
    Catalog-->>MaintenanceWorker: Observations, extraction IDs, expected active revision, and current memory tree reference
    opt Current memory tree exists
      MaintenanceWorker->>Storage: Download current memory tree artifact
      Storage-->>MaintenanceWorker: Memory tree artifact
      Note over MaintenanceWorker: Materialize current memory tree as this activity's temporary maintenance input/worktree
    end
    Note over MaintenanceWorker: Run maintainer
    MaintenanceWorker->>Storage: Store maintainer trajectory
    MaintenanceWorker->>Storage: Store new memory tree artifact
    MaintenanceWorker-->>Temporal: Artifact references, extraction IDs, and expected active revision
    Note over Temporal: Later commit retries reuse this activity result
    Temporal->>MaintenanceWorker: Dispatch revision commit
    MaintenanceWorker->>Catalog: Create memory tree revision with maintenance ID and expected-active-revision CAS
    Catalog-->>MaintenanceWorker: Created or idempotently replayed revision, or revision conflict
  end
```

## Observability and statistics path

```mermaid
sequenceDiagram
  participant Workers as Agent Workers
  participant Langfuse as Langfuse (independent deployment)
  participant Runs as Review Runs
  participant Database as PostgreSQL
  participant UI as Control Plane UI

  Workers-->>Langfuse: Export optional LLM traces and generations
  Note over Workers,Langfuse: Review execution does not wait for observability delivery
  Runs->>Langfuse: Read terminal run observations by run_id
  Langfuse-->>Runs: Review roots and model generations
  Runs->>Database: Persist reconciliation state and aggregate snapshot
  UI->>Runs: Read run details
  Runs-->>UI: Return snapshot, pending state, or no observation record
```

Langfuse stores the individual model-call observations. Review Runs reads and aggregates them into its own database for display in the Control Plane UI.

## Artifact publication and recovery

PostgreSQL and object storage commit separately. Input and memory publishers first persist a publication intent: the intended artifact references and the business payload needed to finish attachment after a crash.

```mermaid
sequenceDiagram
  participant Publisher
  participant Database as Owner database
  participant Storage as Object Storage

  Publisher->>Database: Reserve complete publication intent
  Database-->>Publisher: Reservation accepted
  Publisher->>Storage: Conditional PUT
  Storage-->>Publisher: Upload succeeds, or existing object matches
  Publisher->>Database: Confirm object presence
  Publisher->>Database: Request submission or registration
  Note over Database: One transaction selects the publication intent,<br/>attaches references, and writes business records
  Database-->>Publisher: Commit result
```

After an interruption, retries check the recorded publication intent and object state first. A [Temporal Activity retry](https://docs.temporal.io/activity-definition#idempotency) can repeat an upload after a lost completion response; it does not make storage and SQL one transaction.

| Artifact | Durable recovery basis | Recovery boundary |
| --- | --- | --- |
| Review input bundle | Review Runs publication intent: reference, prepared input, and publish context | A replacement preparation claim can reuse the original publication intent when the object is present. Only definite absence permits abandoning an unused candidate and rebuilding. |
| Extraction trajectory | Memory Catalog publication intent containing the trajectory reference, observation, and summary | Retries check recorded candidates before rerunning the model; selection and extraction registration commit together. |
| Maintenance revision | Memory Catalog publication intent grouping the tree, trajectory, observation IDs, and expected active revision | Different model outputs can be separate candidates; selection, revision creation, observation consumption, and active pointer update commit together. |
| Operator edit revision | Memory Catalog publication intent containing the tree reference, operation ID, and expected active revision; the UI BFF uploads the tree | Retries of unchanged content within the open editor retain the operation ID and original expected revision. The BFF repeats reservation, conditional upload, confirmation, and idempotent revision creation. |
| Run diagnostic bundle in S3 | Temporal publication request and the fixed run key | Recovery verifies the existing bundle against the request before using local files. If neither a complete uploaded bundle nor local artifacts remain, the request cannot reconstruct the diagnostic bytes. |

UI restore moves the active pointer to an existing revision in a Catalog transaction; it creates neither a revision nor an object and does not repair missing bytes.

The input and memory protocols are described in the [Review Runs](../../services/review-runs/README.md) and [Memory Catalog](../../services/memory-catalog/README.md) guides. Storage errors remain uncertain and fail the attempt; they are not evidence that an object is missing. Recorded publication intents support retries, but do not provide automatic background completion after retries are exhausted.

<!-- doc-time-sensitive: artifact-conditional-write-semantics; checked=2026-10-31; source=https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html -->

[Conditional PUT](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html) prevents cooperating publishers from overwriting an occupied key. It does not enforce retention against other identities with overwrite or delete permission. Consumers verify size and SHA-256 before use: this rejects replacement content but cannot recover lost bytes. S3-compatible deployments must verify the APIs and policy conditions they rely on against their deployed storage version.

Abandoning a candidate does not delete its object, and no automatic object garbage collection is implemented. A stale uploader may still finish, and candidates may share content keys. Future cleanup must account for historical revisions, extraction references, and prepared references retained in Temporal history, rather than treating every object without a current database attachment as disposable.
