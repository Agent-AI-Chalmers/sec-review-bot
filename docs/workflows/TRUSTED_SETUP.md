# Trusted Setup

Language: English | [中文](TRUSTED_SETUP.zh.md)

A repository can declare review-environment preparation in `.sec-review/setup.yml` on its **default branch**. This page explains **why** that source restriction exists, approval for fork reviews, and the execution conditions. The file format is a separate [setup-declaration](../../contracts/setup-declaration/README.md).

## The Problem

A generic Docker sandbox image **does not preinstall every reviewed repository's dependencies**. Without them, the agent may be unable to run tests. Guessing installation commands during a review can also cause version mismatches, delays, and inconsistent results.

Maintainers can instead supply explicit preparation steps to run before the agent starts. Because **those steps execute commands**, the design must specify which sources may provide them as well as the file format.

## Which Sources Are Trusted

**Different sources have different authority**; belonging to the same repository does not make every source equally trusted.

| Source | Basis for the choice | Project restriction |
| --- | --- | --- |
| Default branch | Managed by the target repository's maintainers | GitHub Integration reads declarations **only from here** |
| PR head or fork | Editable by the PR author and not yet merged into the target branch | Never supplies declarations; reviewing fork code requires explicit approval for each run |
| Webhook payload | May refer to another branch | Cannot replace API-resolved default-branch information |
| Declaration content | Can execute commands | Strict format validation and execution in a restricted sandbox |
| Network | Repository code may abuse access | Deployment policy controls access; repositories and forks cannot expand it |

## Enforcing The Restrictions

### Declarations Come From The Default Branch

The project selects the target repository's default branch as the declaration source, rather than PR-author-controlled content.

- **Resolve the default branch through the API.** Issue, PR, and repository entry points obtain `{default_branch, head_sha}` from GitHub using the repository identity. Failure stops the run; a webhook ref is not a fallback. A branch SHA in a request does not establish that it is the default branch.
- **Use the PR's base repository.** `base_repo_full_name` identifies the target, not the head repository or fork. The reviewed workspace may contain PR head code, but setup instructions still come from the target's default branch.

The declaration is not read from the checked-out workspace either. Falling back to payload data or workspace contents after an API failure would change the trusted source and must not happen silently.

<!-- doc-time-sensitive: copilot-setup-default-branch; checked=2026-11-09; source=https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-environment -->
GitHub Copilot requires the setup steps file to be present on the default branch; see its [documentation](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-environment). GitHub Integration defines this project’s fetching and validation rules.

### Fork Reviews Need Approval For Each Run

Fork PR `opened`, `ready_for_review`, and `synchronize` events do not start reviews automatically. A maintainer with repository write permission can comment `@<bot> review` to start one review. That comment authorizes only the current run; approval is not stored for future runs.

The project uses this single explicit signal, rather than reusing approval state from other GitHub features.

Approval does not change the declaration source or deployment network policy. A fork cannot replace the trusted declaration or modify that policy; the reviewed fork code remains potentially adversarial executable input. `from_fork` requires approval rather than classifying content as malicious or relaxing any other restriction.

### Declarations And Repository Code Run In Sandboxes

A controlled declaration source does not make executable content inherently safe. Sandboxed stages use separate containers with unique names and `--rm`, mount only declared directory views, and do not inherit cross-repository credentials or App private keys through the host environment.

The directory-only mount API prevents directly mounting a bare key file. It does not prevent secrets from appearing inside a mounted directory, image, or declaration. Deployers must keep those inputs free of credentials the sandbox should not receive. Container isolation does not replace network policy when networking is enabled.

The project does not use a permanently disconnected sandbox plus a host-side dependency-cache filler. Network mode is **a deployment choice**, with **`none` as the default** rather than default connectivity.

### Network Permission Belongs To The Deployer

<!-- doc-default: AGENT_DOCKER_NETWORK_MODE; source=agents/src/sec_review_agents/filesystem/docker_runtime.py -->
The **deployer** controls sandbox networking through `AGENT_DOCKER_NETWORK_MODE` and defaults to `none`. Neither a repository nor a fork can modify that setting through a declaration or grant itself access beyond deployment policy.

## Other Design Choices

These choices concern how preparation works, rather than which source is trusted.

**Generic images do not preinstall repository dependencies.** The image provides an isolated environment and general tools. Declarations describe repository-specific installation instead of continually expanding images for different languages, frameworks, and repositories.

**Agents do not execute in GitHub Actions.** Reviews run in execution-node containers. Actions triggers the task rather than hosting long model investigations and dependency installation.

**Use this project's declaration format.** `.sec-review/setup.yml` describes only the required preparation information. The project does not directly interpret another system's configuration, such as `.github/workflows/copilot-setup-steps.yml`, which would require extra Actions YAML and `uses:` semantics just to extract installation commands.

**Prepare each sandbox separately.** Analyzer, Mitigator, Verifier, and other sandboxed Agents run declarations separately; repository cases do so independently. Sandboxes do not share dependency caches. Declarations should be repeatable and reasonably fast. `SEC_REVIEW_SETUP_STEP_MAX_SECONDS` limits each step's duration in one execution, not the total number of executions.

**Do not infer installation commands from repository files.** Only explicit declarations trigger preparation. The project does not run installation scripts based on lockfile or directory conventions, or provide a default guessing fallback. Without a declaration, the base sandbox remains available without automatically installing repository dependencies.
