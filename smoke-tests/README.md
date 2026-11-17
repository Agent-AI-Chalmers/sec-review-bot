# Smoke tests

Language: English | [中文](README.zh.md)

## Run

Install Docker Engine and Docker Compose 2.24.4 or newer. From the repository root:

```bash
bash smoke-tests/run.sh
```

The script builds the services from their production Dockerfiles and builds a test image for the probes. The root [`compose.yaml`](../compose.yaml) defines how the services are built and connected. [`compose.test.yaml`](compose.test.yaml) changes their ports and data volumes for testing and adds the probe container. The script combines both files to start the services and wait for them to be ready. You do not need Node or pnpm on the host.

The first run may download dependencies and infrastructure images. Docker keeps the built images and layers for later runs.

## What the smoke checks

<!-- doc-default: smoke-tests.scenarios; source=smoke-tests/run.sh -->

The smoke uses public HTTP, S3, and Temporal CLI interfaces:

| Scenario                       | Operation                                                                                                                                                                                   | Expected result                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Health and authentication      | Read health, readiness, and protected endpoints with and without credentials.                                                                                                               | Services and databases are ready; authenticated reads succeed and unauthenticated requests are rejected.               |
| Admission replay               | Admit the same task twice through Review Runs.                                                                                                                                              | Both requests identify the same task; the second grants no new preparation claim.                                      |
| Input storage                  | Use identities provisioned by the production RustFS initializer to upload with Integration credentials and download with Execution credentials. Attempt a write with Execution credentials. | Bytes, size, media type, and SHA-256 match the shared archive; the unauthorized write is rejected.                     |
| Execution submission           | Register the verified S3 reference and submit through Review Runs → Execution Gateway → Temporal.                                                                                           | Gateway reports `running`; Review Runs records preparation as submitted.                                               |
| Submission replay and conflict | Replay the same Gateway submission, then change its input under the same ID. Compare Temporal execution IDs through the CLI.                                                                | Identical replay succeeds, changed input conflicts, and the execution ID stays unchanged.                              |
| Gateway restart                | Restart Gateway, query the original execution before replay, then repeat the replay/conflict checks.                                                                                        | The original execution remains readable and its Temporal execution ID stays unchanged.                                 |
| Review Runs restart            | Stop Review Runs, terminate the execution while it is offline, then restart Review Runs.                                                                                                    | The task remains readable and listed; Review Runs observes the failed terminal state through Gateway.                  |
| Console task read              | Log in to the production UI service and read the existing task through its BFF.                                                                                                             | The authenticated list and detail identify the real task and its failed execution.                                     |
| Console memory round trip      | Create a memory version through the UI BFF, list versions, and read back its file content.                                                                                                  | Catalog commits the version in PostgreSQL; the UI reads matching content from RustFS with its own storage credentials. |

## What it does not check

The storage probe uploads and downloads an archive from the shared input-bundle corpus. No worker listens on the test queue, so this does not check whether a worker can unpack or use the archive.

Input preparation, agent execution, model calls, and GitHub publication are outside this test. Console checks send HTTP requests to the production BFF; they do not use Playwright or check what the browser displays.

## Isolation and cleanup

<!-- doc-default: smoke-tests.isolation; source=smoke-tests/run.sh -->

Each run gets its own Compose project and named data volumes. It uses fixed test credentials, ignores the operator's `.env`, and does not publish ports on the host.

If a check fails, the script prints container status and logs. On exit, it removes the containers, networks, and data volumes. It keeps images and build caches.

## Files

| File                | Responsibility                                                                |
| ------------------- | ----------------------------------------------------------------------------- |
| `run.sh`            | Environment setup, Compose lifecycle, Temporal CLI calls, and cleanup.        |
| `probe.ts`          | Parse command-line arguments and run the selected checks.                     |
| `review-runs.ts`    | Admission and restart recovery checks.                                        |
| `execution.ts`      | Submission, replay, conflict, and Temporal execution identity checks.         |
| `bff.ts`            | Session login, task reads, and memory content round trips through the UI BFF. |
| `credentials.ts`    | Read test tokens passed by Compose from the single definition in `run.sh`.    |
| `http.ts`           | Shared HTTP transport and service addresses.                                  |
| `storage-probe.ts`  | S3 transport and permission checks through the public AWS SDK.                |
| `Dockerfile`        | Compile the TypeScript probes and provide their runtime environment.          |
| `compose.test.yaml` | Test overrides and the probe service.                                         |

Test dependencies are listed in this package and locked in the root pnpm lockfile. Production services do not depend on the probes.

## Development checks

Install the root workspace dependencies, then run from `smoke-tests/`:

```bash
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run test:smoke
```

`test:smoke` builds and runs Docker containers. The default workspace test command does not run it.
