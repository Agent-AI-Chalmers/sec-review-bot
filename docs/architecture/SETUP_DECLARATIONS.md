# Setup Declarations

A repository can declare how to prepare the sandbox it is reviewed in. The declaration is a small YAML file at `.sec-review/setup.yml` on the repository's **default branch**. When a review runs, the declaration is executed inside the Docker sandbox before the agent starts, so the agent begins in an environment with its dependencies already installed. The declaration is optional; a repository without one is reviewed in a declaration-free environment.

## Declaration Format

The format is specified by its own contract: **[contracts/setup-declaration/v1/SPEC.md](../../contracts/setup-declaration/v1/SPEC.md)**. That specification, the shared test corpus next to it, and the two parser implementations in code change together. Do not restate the field-by-field format here — this page covers how a declaration reaches the sandbox, how it runs, and the trust and operational boundaries.

Two format-level points matter at the architecture level:

- **Blank content means "no declaration".** An empty or whitespace-only file is treated exactly like a missing file; it is not an error.
- **Invalid content fails the run.** A file that exists, is not blank, and does not match the format is a maintainer error on the default branch. It is rejected **before** the run is submitted, with the repository/ref/path attached, and the run is marked failed (`SETUP_DECLARATION_INVALID`). It does not silently degrade to an unbootstrapped environment — that would let the agent reason about a repository whose dependencies were never installed. This matches how an invalid `.sec-review/config.yml` is handled.

## Who Owns the Rules

The **GitHub integration owns the content rules**, because it produces the runner workflow input and must produce something that satisfies the runner contract. It validates the declaration against the same allow-list the runner uses, and rejects an invalid one with attribution. The runner then parses the text again as defense in depth, and executes it. A shared corpus (`contracts/setup-declaration/v1/corpus/`) is run by both sides' tests so the two implementations cannot silently drift.

Local runs (`run-local-*`) validate the file through the runner's own parser, so a local declaration fails the same way a repository's default-branch declaration would.

## How the Declaration Reaches the Sandbox

The declaration is carried as **inline text**, not as a file path:

1. The GitHub integration reads `.sec-review/setup.yml` from the base repository's default branch, validates it, and puts its **contents** in the workflow input under the optional top-level string field `setup_declaration`.
2. The runner passes that string down the workflow. There is no declaration file in the input bundle, no manifest field for it, and no mount for it in the container.
3. Before the agent runs, each stage parses the string and executes its steps inside the sandbox.

Because the contents are inline, there is no "declaration file not found" path; the only declaration-specific failure modes are "rejected as invalid before submission" and "a step fails at execution time".

## Execution Semantics

- **Docker only.** Only the Docker backend runs a declaration, because its container is long-lived and one bootstrap is reused for the whole stage. On other backends the declaration has no effect.
- **Best effort.** A failing step stops the remaining steps and marks the environment incomplete, but the review still proceeds.
- **Recorded, not silent.** The stage writes `environment.json` next to its other artifacts with `setup_status` (`not_declared`, `completed`, or `incomplete`), `environment_incomplete`, and each step's exit code and truncated output. Output is truncated, **not redacted**: it is operator-visible and may contain registry URLs or tokens from install commands.
- **Not given to the agent.** The declaration and its outcome are not placed in the agent's context; the agent reasons from the repository.

The network available during bootstrap is the deployer's baseline (`AGENT_DOCKER_NETWORK_MODE`), and the repository cannot widen it. A declaration that needs the network fails as an incomplete environment when the baseline denies it.

### Operational notes

- **Isolation.** The declaration runs in the same container, as the same user, with the same network as the agent. It can change `/workspace` and anything else the agent later reads. A declaration is only useful if it can do that, so it is not sandboxed further. Adding a new source for `setup_declaration` therefore means handing that source code execution in the agent's container; keep the default-branch-only rule.
- **Output persistence.** `environment.json` (including each step's truncated output) is written to the operator-local artifact tree (`.agent-artifacts` / `SEC_REVIEW_AGENT_ARTIFACT_ROOT`). It is not sent to GitHub. The intended reader is the operator, so output is not redacted; a declaration that echoes a registry token will persist it there. Treat the artifact tree as credential-bearing operator data.
- **Blank declaration.** A `.sec-review/setup.yml` that exists but holds only whitespace is treated as if it did not exist, so a cosmetic file cannot fail the run.

## Trust Boundary

Trust in the declaration's origin is decided **upstream**, by the GitHub integration: it is read from the base repository's default branch, never from a fork or a payload-supplied ref. The runner does not authenticate the declaration against a source; it parses the text strictly and executes it. Callers that supply a declaration out of band, such as the `run-local-*` commands, own its provenance (they do validate its content, just not where it came from).

## Local Runs

The `run-local-issue`, `run-local-pr`, and `run-local-repository` commands accept `--setup-declaration <path>`. They read the file once and pass its contents inline, the same way the integration does. The declaration runs only on the Docker backend; on any other backend the command warns and ignores it.

`.sec-review/config.yml` is the repository's trigger configuration (`trigger_mode`, `paths_ignore`). It is separate from `.sec-review/setup.yml` and is read by the GitHub integration, not by the runner.
