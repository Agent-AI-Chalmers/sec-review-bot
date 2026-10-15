# Setup Declarations

A repository can declare how to prepare the sandbox it is reviewed in. The declaration is a small YAML file at `.sec-review/setup.yml` on the repository's **default branch**. When a review runs, the declaration is executed inside the Docker sandbox before the agent starts, so the agent begins in an environment with its dependencies already installed. The declaration is optional; a repository without one is reviewed in a declaration-free environment.

## Declaration Format

```yaml
setup:
  - run: pip3 install --no-input uv
    timeout_seconds: 300
  - run: uv sync --frozen
    working-directory: agents
    timeout_seconds: 600
```

Top level:

- `setup`: required; a list of steps executed in order.

Each step:

| Key | Required | Meaning |
| --- | --- | --- |
| `run` | yes | Shell command to execute in the container. |
| `working-directory` | no | Directory relative to the repository root. It must stay inside the root (no absolute paths or `..`). Defaults to the repository root. |
| `env` | no | Mapping of environment variable names to values, exported before `run`. Names must be valid shell identifiers. |
| `timeout_seconds` | no | Per-step timeout. Defaults to 300 and is capped at `SEC_REVIEW_SETUP_STEP_MAX_SECONDS` (default 600). |

Parsing is strict: anything outside this schema — an unknown key, a non-list `setup`, an invalid environment-variable name, a step missing `run` — rejects the whole declaration rather than being ignored.

## How the Declaration Reaches the Sandbox

The declaration is carried as **inline text**, not as a file path:

1. The GitHub integration reads `.sec-review/setup.yml` from the base repository's default branch and puts its **contents** in the workflow input under the optional top-level string field `setup_declaration`.
2. The runner passes that string down the workflow. There is no declaration file in the input bundle, no manifest field for it, and no mount for it in the container.
3. Before the agent runs, each stage parses the string and executes its steps inside the sandbox.

Because the contents are inline, the only failure mode is a parse error. There is no "declaration file not found" path.

## Execution Semantics

- **Docker only.** Only the Docker backend runs a declaration, because its container is long-lived and one bootstrap is reused for the whole stage. On other backends the declaration has no effect.
- **Best effort.** A failing step stops the remaining steps and marks the environment incomplete, but the review still proceeds.
- **Recorded, not silent.** The stage writes `environment.json` next to its other artifacts with `setup_status` (`not_declared`, `completed`, or `incomplete`), `environment_incomplete`, and each step's exit code and truncated output. Output is truncated, **not redacted**: it is operator-visible and may contain registry URLs or tokens from install commands.
- **Not given to the agent.** The declaration and its outcome are not placed in the agent's context; the agent reasons from the repository.

The network available during bootstrap is the deployer's baseline (`AGENT_DOCKER_NETWORK_MODE`), and the repository cannot widen it. A declaration that needs the network fails as an incomplete environment when the baseline denies it.

## Trust Boundary

Trust in the declaration's origin is decided **upstream**, by the GitHub integration: it is read from the base repository's default branch, never from a fork or a payload-supplied ref. The runner does not authenticate the declaration against a source; it parses the text strictly and executes it. Callers that supply a declaration out of band, such as the `run-local-*` commands, own its provenance.

## Local Runs

The `run-local-issue`, `run-local-pr`, and `run-local-repository` commands accept `--setup-declaration <path>`. They read the file once and pass its contents inline, the same way the integration does. The declaration runs only on the Docker backend; on any other backend the command warns and ignores it.

`.sec-review/config.yml` is the repository's trigger configuration (`trigger_mode`, `paths_ignore`). It is separate from `.sec-review/setup.yml` and is read by the GitHub integration, not by the runner.
