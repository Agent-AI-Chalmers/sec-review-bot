# GitHub Actions Source/Sink Reference

Use this reference for GitHub Actions workflows, composite actions, local reusable actions, workflow-triggered shell scripts, and artifacts or caches crossing trust boundaries.

## Sources

- `.github/workflows/*.yml` / `.yaml`
- `action.yml` / `action.yaml`
- `.github/actions/**/action.yml`
- Scripts called by workflows, especially under `.github/`, `scripts/`, `Makefile`, package scripts, or release/deploy helpers.
- Untrusted PR fields: title, body, branch name, head ref, labels controlled by non-maintainers, changed files, commit messages.
- Untrusted issue/comment/discussion fields.
- `workflow_dispatch` inputs when accessible to untrusted users.
- `workflow_run` inputs and artifacts from lower-privilege workflows, especially when the follow-up workflow has secrets or write permissions.
- Approval or label/comment gates whose triggering comment, author, target SHA, or checked approval state can diverge from the code/artifact later used.
- Artifacts, caches, coverage reports, generated files, dependency outputs, or build outputs produced by untrusted jobs.
- Fork PR code checked out into a privileged job.
- Mutable refs, branch names, tags, or untrusted SHAs used for checkout, release, package, deploy, or trusted status decisions.

## Sinks

- `run:` shell scripts containing direct `${{ github.event.* }}` or other untrusted expression interpolation.
- `pull_request_target` jobs that checkout or execute fork-controlled code with write token or secrets.
- `workflow_run` jobs that download, extract, execute, publish, comment with, or make trust decisions from artifacts produced by untrusted workflows.
- Workflows that expose secrets to untrusted code, publish packages/releases, modify repository contents, comment with privileged tokens, or deploy infrastructure.
- `actions/github-script`, `gh`, curl, package manager scripts, or local actions that execute attacker-influenced strings or files.
- Artifact download/extraction followed by execution, sourcing, upload to release/package, or use in trusted reports.
- Checkout of mutable attacker-controlled refs or branches in privileged jobs.

## Guards

- Pass untrusted GitHub expression values through environment variables and quote them in shell; do not inline them into `run:` commands.
- Prefer `pull_request` for untrusted fork code. Treat `pull_request_target` as privileged; require explicit gating and avoid executing fork-controlled code.
- If privileged workflow must inspect fork code, checkout the trusted base by default and fetch untrusted content only as data.
- Treat `workflow_run` as privileged when it has secrets or write token. If artifacts from untrusted workflows are executed, sourced, published, released, deployed, or used for trust decisions, verify they came from the expected run/commit and handle them safely. Missing artifact attestation or cryptographic binding alone is not a finding.
- Pin approval gates to the exact commit/artifact that was approved; re-check author permissions and target SHA at the privileged step.
- Set explicit minimal `permissions`.
- Pinning actions can reduce supply-chain drift, but pinning alone does not fix untrusted input execution.
- Label or maintainer approval gates help only if the gate cannot be attacker-controlled and the workflow checks the trusted event state.

## Report Conditions

- State the attacker role: external fork contributor, issue commenter, repository member without write access, compromised dependency, or other concrete actor.
- Trace untrusted source to privileged sink and explain why existing guards do not break the path.
- Identify the privileged effect: secret exposure, write-token use, release/package tampering, deployment, repository modification, or command execution in a trusted context.
- For script injection, show the expression or artifact that becomes shell code or command arguments.

## False-Positive Precedents

- GitHub Actions keyword presence is not enough. `pull_request_target`, `permissions`, `secrets`, or `${{ }}` must be tied to a concrete attack path.
- A workflow using `pull_request_target` is not automatically exploitable if it never checks out or executes attacker-controlled code and does not use untrusted input in privileged sinks.
- A workflow using `workflow_run` is not automatically exploitable if it treats upstream artifacts as inert data and does not grant attacker-controlled content a privileged effect.
- Direct expression interpolation is not always exploitable; distinguish values used as data from values parsed by shell, JavaScript, templates, or workflow commands.
- Missing CodeQL, missing Dependabot, unpinned major versions, or non-minimal permissions are hardening concerns unless paired with a reachable exploit-relevant path.
- Workflows in other repositories are out of scope unless their behavior is materialized or the current repository controls the referenced action/script.
