# Coordinating Work in PostgreSQL

Language: English | [中文](POSTGRES_COORDINATION.zh.md)

Review Runs and Memory Catalog keep their coordination state in their own PostgreSQL databases and change it with hand-written SQL. They use no workflow engine, ORM, or typed-SQL generator, and some of their statements run to dozens of lines. This document explains why the SQL looks the way it does, how each service uses it, which alternatives were evaluated, and what to check when you change a statement.

Read it before you replace the coordination layer, move its queries elsewhere, or shorten them.

## The Problem Both Services Solve

Workers, connectors, and the console can act on the same record at the same time, and any of them can stop halfway. Some of their effects also happen outside the database, such as a pull request on GitHub or an object in S3. A PostgreSQL transaction cannot roll those back, and after a crash nobody may know whether one happened.

A typical case: a GitHub Integration process claims a finished run, opens a draft pull request, and crashes before it records the pull request. Another process later picks up the same run. If it trusts the database alone, it opens a second pull request. If it instead assumes the first one exists, it may report a delivery that was never made.

Both services therefore guarantee three things:

- One writer decides. When several writers compete, exactly one changes the record, and the others find out they lost instead of overwriting the winner.
- Retries are safe. Repeating a request after its response was lost returns the original outcome and does not do the work twice.
- Unknown outcomes are checked before anyone concludes. When an external effect may or may not have happened, the service records that it is uncertain and looks at the external system before deciding.

These guarantees hold only when the check and the write are atomic: they run in one transaction, on rows the same statement locks or compares. Writing that in SQL is what makes the statements long.

## Terms Used Here

- A claim is a time-limited right to work on a record. The claimant receives a claim token and renews the claim's lease while it works. When the lease expires, another process may claim the work.
- An axis is one lifecycle of a Review Runs run. Each run has three: preparation, execution, and publication. They have separate states.
- A publication step is one external side effect within a publication, for example one draft pull request for one repository delivery. Each step has its own state and attempt budget.
- `uncertain` and `disconnected` describe different recovery conditions on each axis; use the axis as well as the status when interpreting a run.
- Memory Catalog uses `automation.version` to identify the automation switch state and `active_version` to identify the memory tree currently in use. Writes carry `expected_version` or `expected_active_version` so the server can reject operations based on stale state.

## Recovery Meaning By Axis

<!-- doc-default: review-runs.recovery-meaning; source=contracts/review-runs-api/v1/openapi.yaml -->

| Scope            | `uncertain`                                                                                                         | `disconnected`                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Preparation      | The preparer's claim expired before it reported; preparation can be reclaimed to establish or rebuild its input.    | The run's own records prevent automatic conclusion, such as execution already having advanced when preparation expires. |
| Execution        | Submission may have reached the Execution Gateway without a confirmed response; recovery replays the same `run_id`. | The submission recovery budget ended without a conclusive answer.                                                       |
| Publication step | Attempts are exhausted and a remote write may have taken effect; the connector reconciles before concluding.        | Reconciliation exhausted its budget without a conclusive answer.                                                        |
| Publication axis | A step has an uncertain remote outcome.                                                                             | A step requires an operator decision after reconciliation stopped.                                                      |

`disconnected` stops automatic recovery on that scope. Resume returns an eligible scope to recovery; preparation can resume only while execution remains `pending`. Give-up records an operator decision to stop waiting without establishing that a remote effect did not occur. Abandon is a separate preparation operation for contradictory records. The [Review Runs guide](../../services/review-runs/README.md) and contract define the allowed operations and their consequences.

A publication step's `failed` means its last attempt failed; it can still be retried while attempts remain, or reconciled after exhaustion. `terminal_failed` is its final failure. An axis's `failed` is a terminal conclusion. Do not infer retryability from the word `failed` without identifying the scope.

## Other State Boundaries

The run's axes do not describe every queue or publication candidate. [Artifact publication](ARTIFACT_PUBLICATION.md#publication-candidate-states) lists the input and memory candidate transitions.

<!-- doc-default: review-runs.notice-transitions; source=services/review-runs/src/persistence/run-notices.ts -->

A run notice starts `pending`, becomes `delivering` when claimed, and concludes as `delivered` or `failed`. An expired delivery can be reclaimed with a new token while remaining `delivering`. Resuming a disconnected axis supersedes its undelivered attention notices (`pending` or `delivering → superseded`) in the same transaction and invalidates their claims. Delivered notices and failure notices are not superseded by resume. A notice's `failed` describes notification delivery, not the review outcome.

<!-- doc-default: review-runs.statistics-transitions; source=services/review-runs/src/statistics/execution-statistics-store.ts -->

Execution statistics has its own `pending → reconciling` claim loop. A successful read can return to `pending` while waiting for stable observations, or become `settled` when observations stabilize or the collection window ends. Read failures can return to `pending`; exhausted read-failure retries or rate-limit deferral end as `unavailable`. Interrupted claims can be reclaimed. `ingestion_status` explains the collected snapshot's completeness, and `usage_coverage` describes reported usage; neither is an execution lifecycle status.

<!-- doc-default: execution-gateway.status-projection; source=services/execution-gateway/src/temporal-execution-client.ts -->

Execution Gateway projects Temporal state on each read instead of maintaining another run-state table. Temporal `RUNNING` maps to `running`; a completed workflow becomes `succeeded` only when its success envelope, result, workflow identity, and artifact reference pass validation. Invalid or unsuccessful completed results and other terminal Temporal statuses map to `failed`. `queued` can be returned immediately after submission when no execution record is yet available. Review Runs separately records its observations of that API, so a Gateway status and a coordination recovery status answer different questions.

## Shared Principles

- The decision happens in the database. Every coordinating write locks or compares the current state in the same transaction that changes it. Application code never reads a state, decides in memory, and writes the result back in a separate step.
- Callers state what they expect. A write carries the state it expects to replace: a claim token in Review Runs, or an expected version or active version in Memory Catalog. If it does not match, another writer won.
- Retries are keyed by an identity the caller chooses. Repeating a request with the same `run_id`, ingress key, or `operation_id` and the same content returns the original result. The same identity with different content is a conflict.
- Intent is recorded before an external effect. Before it uploads an object or writes to a remote system, the service records what it is about to do. A retry starts from that record and checks the external system instead of assuming the effect is missing.
- SQL stays next to the code that runs it. A query used in one place stays inline, so the comment that explains a lock or a guard sits beside the clause it explains. A fragment that repeats across statements and carries one rule becomes a named module constant. Such constants are built only from literals in the module, never from caller input.

## How Each Service Applies Them

| Concern                    | Review Runs                                                                                                                | Memory Catalog                                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Who acts                   | Whoever holds the claim. A worker or connector claims work and renews the lease while working                              | Each HTTP request, holding its locks for one transaction only                                                                                 |
| Serializing writers        | `SELECT ... FOR UPDATE` and `FOR UPDATE SKIP LOCKED` on the work rows                                                      | `pg_advisory_xact_lock` on the operation or extraction identity, plus `FOR UPDATE` on singleton state rows                                    |
| Detecting a lost race      | The claim token no longer matches, so the write changes no row and returns `false`                                         | The expected version or active version no longer matches, so the service answers HTTP 409                                                     |
| Uncertain external effects | The row moves to `uncertain` and the connector reconciles it. If reconciliation cannot conclude, it becomes `disconnected` | Publication intents are reserved, confirmed after upload, and selected on registration. A storage error stays uncertain and fails the attempt |
| Audit trail                | Every axis and publication step transition is written to `review_run_events` in the same transaction                       | Versions, restore operations, and publication intents are the durable record                                                                  |
| Lifecycle source of truth  | `x-state-machines` in the [Review Runs API contract](../../contracts/review-runs-api/v1/openapi.yaml)                      | The schema's `CHECK` constraints and the [Memory Catalog API contract](../../contracts/memory-catalog-api/README.md)                          |

GitHub Integration keeps no coordination state of its own. It is the client of the Review Runs protocol: it claims work, renews leases, treats a failed renewal as lost ownership, and checks GitHub before it reports the outcome of an uncertain step.

### Review Runs Specifics

Review Runs holds the most coordination state, so it has rules Memory Catalog does not need:

- A mismatch is a normal result. A write whose preconditions no longer hold changes nothing, and the caller reads `rowCount !== 1` as "you no longer own this work". Raising a database error instead would abort the surrounding transaction, so preconditions stay in the `WHERE` clause.
- Steps are written under the publication lock. Every write to `publication_steps` first locks the owning `publications` row. A single `UPDATE ... FROM publications` reads the publication without locking it, so a concurrent conclusion could commit between the read and the write.
- Steps end one at a time. A terminal step failure ends only that step, and the connector decides whether the publication goes on. It publishes its remaining steps and then concludes the publication through `complete`, which is refused while any step has not succeeded, or through `fail`. A step whose reconciliation lookup keeps failing does not hold up the others either: it spends its own budget and parks as `disconnected` while the other steps are still attempted.
- The three axes behave alike. The publication axis stores `uncertain` and `disconnected` like the preparation and execution axes, derived from its steps, so operator queues, notices, and the console handle all three the same way.

## Alternatives Evaluated

<!-- doc-time-sensitive: pgtyped-typescript-support; checked=2026-11-15; source=https://github.com/adelsz/pgtyped/blob/master/packages/cli/package.json -->
<!-- doc-time-sensitive: safeql-node-postgres-integration; checked=2026-11-15; source=https://safeql.dev/compatibility/node-postgres.html -->

| Alternative                                                                                            | Why it was not adopted                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Temporal](https://temporal.io/) workflows for coordination                                            | Temporal retries activities, but it cannot tell whether a GitHub write or an upload already happened, so the reconciliation logic would still be written by hand. Coordination state would also leave PostgreSQL, where operators and tests query it directly. Temporal remains the execution engine for review and memory workflows. |
| An ORM or query builder, such as [Drizzle](https://orm.drizzle.team/) or [Kysely](https://kysely.dev/) | Locks, guarded updates, and `RETURNING` the previous state are harder to read through a builder, and splitting a guarded update into a read and a write brings the race back.                                                                                                                                                         |
| Moving queries into `.sql` files                                                                       | The SQL would be just as long in another file, and each guard would sit away from the comment that explains it.                                                                                                                                                                                                                       |
| [PgTyped](https://pgtyped.dev/) (types generated from SQL)                                             | It cannot type queries that interpolate module constants. Both schemas use `CHECK` constraints instead of enums, so it widens status columns to `string`. It needs a running database to generate types, and when it was evaluated its supported TypeScript range did not include the version this repository uses.                   |
| [SafeQL](https://safeql.dev/) (ESLint checks against a live database)                                  | It checks only `sql`-tagged templates, so every existing call site would need rewriting, and one left unconverted passes silently. It treats interpolated constants as parameters, cannot narrow a status union from a `WHERE` clause, and needs a database during lint.                                                              |
| Database-enforced transitions (an allowed-transitions table with a trigger or constraint)              | Most `WHERE` conditions check ownership, expected versions, and budgets, which a transition table cannot express. In Review Runs, moving the remaining legality checks into the database would turn a lost race into a transaction-aborting error, and the edge-coverage test already rejects undeclared transitions.                 |
| Review Runs publication storing only its own conclusion and projecting step state on read              | The publication axis would stop behaving like the other two: the parked-run queue, operator decisions, and notices would each need a publication-specific rule, and the contract would need a separate notion of projected states.                                                                                                    |

## What Keeps the SQL Safe to Change

Long statements are acceptable as long as a wrong edit gets caught.

In Review Runs:

- The state-machine edge test drives every write path and compares the recorded transitions and their reason codes with the contract.
- The same test checks every live publication axis against its steps, so a write path that forgets to re-derive the axis fails.
- Comments beside each lock order and guard explain the race it prevents and how to reproduce it.

In both services:

- Integration tests run conflicts, replays, pauses, and abandonment against a real PostgreSQL database.
- Integration tests assert that timestamps leave each store as ISO strings. node-pg returns `timestamptz` columns as `Date`, and JSON serialization hides the difference.

When you change a statement, keep its preconditions in the same statement, keep any audit or notice write in the same transaction, and run the service's PostgreSQL integration tests. If a fragment starts repeating, give it a name. A new state or step type is a contract change.
