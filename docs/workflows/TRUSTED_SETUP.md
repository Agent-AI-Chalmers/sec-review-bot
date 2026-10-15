# Trusted Setup

Language: English | [中文](TRUSTED_SETUP.zh.md)

A repository can declare, on its **default branch**, how to prepare the environment it is reviewed in. This page records **why** that feature is shaped the way it is: the problem, what trust question it raises, the constraints that follow from the trust model, and the choices that are not about trust.

The declaration's format is a separate contract: [contracts/setup-declaration](../../contracts/setup-declaration/README.md).

## The Problem

The agent reviews a repository inside a Docker sandbox whose image does **not** contain that repository's dependencies. In practice the agent then behaves non-deterministically: it gives up and guesses from memory, or it installs dependencies on the fly from a cold public network — slow, incomplete (a missing `uv`, a mismatched Python), and intermittent.

The obvious fix is to let the repository declare how to prepare its own environment, and run that declaration before the agent starts. But that fix creates the real problem: **the declaration is executable content supplied by the repository**, so "how do we install dependencies" immediately becomes "how far do we trust what the repository hands us?". Everything else in this design is an answer to that question.

## The Trust Question

Trust is not a switch; it is **scarce**, and it is allocated per source. The design's whole shape follows from deciding, for each source that can reach the sandbox, how much it is trusted and what that permission buys.

| Source | Why it stands where it does | Constraint it yields |
|---|---|---|
| The default branch (content a maintainer has merged) | Reviewed and merged; the repository's controlled surface | The **only** legitimate source of the declaration |
| A PR head / a fork | The author controls it and it is not yet merged | Never a declaration source; an external fork needs explicit approval |
| A webhook payload | It can name any branch | Never the source of the trusted ref |
| The declaration's content | It is executable content | Strict allow-list; least privilege; run isolated |
| The network | Untrusted code could misuse it | The baseline is set by the deployer; a repository or fork can only tighten it |

Read down the "constraint" column and the rest of the design is already implied.

## The Trust Model in Practice

### The declaration comes only from the default branch

The default branch is the one surface a maintainer has reviewed and merged, so it is the only surface allowed to supply executable content. Two rules enforce it:

- **Resolve the default branch via the API, never from the payload.** Every entry point — issue, pull request, repository — resolves `{default_branch, head_sha}` by calling GitHub with the repository's own identity; a webhook payload field is never the source, and a failed resolution fails the run. A payload can name any branch, so "the SHA of branch X in the payload" does not prove "X is the default branch".
- **For a pull request, use the base repository.** The identity is the base repo (`base_repo_full_name`), never the head/fork. A PR's workspace is checked out at the head, which the author controls; it must not be able to change the declaration that runs.

The rejected alternative is API-first with a payload fallback — a fallback is *fake trust*, silently degrading to an untrusted source. (And reading the declaration from the workspace or the head repo, for the same reason.)

This is not an invented rule: GitHub Copilot's own setup steps must likewise come from the default branch. The trust reasoning is identical, and this design keeps the same line.

### A fork is a stranger

An automatic review of fork code does not match a trust model built around the trusted repository's controlled surface.

Fork pull request events (`opened`, `ready_for_review`, `synchronize`) are skipped. A maintainer comments `@<bot> review` to approve, reusing the existing write-permission check. The approval is per-run: each comment starts its own review, and it is not stored or reused, so an earlier approval never authorizes a later review.

GitHub treats a fork's first run as needing approval, but its approval signals are many and semantically different. This system has fewer isolation tools, so it converges on a single, explicit, per-run approval.

Either way, the declaration still comes from the base default branch, and the network baseline is the deployer's — a fork cannot change what runs or how far it can reach. Note that `from_fork` does not mean "malicious" (a same-org fork is still a fork), so it is used only to require an explicit approval, never to relax a rule.

### Because it is not trusted, it is isolated

The declaration may reach the network, and it may be adversarial. That is safe only because of an isolation baseline — one container per run/stage (unique name, `--rm`), an empty container environment (no cross-repository credentials injected), minimal mounts (only the paths the views declare; a bare file such as the App private key cannot be mounted at all, because mounts must be directories), and no cross-repository credential or App private key ever entering the container. This mirrors how hosted CI runners are default-online and rely on per-job isolation rather than disconnection.

The rejected alternative is a permanently `--network none` sandbox plus a host-side "filler" cache pool. With the network available, that machinery is unnecessary; the design keeps `none` as the *default* and the baseline *configurable*, with safety from the isolation baseline, not from a hard-coded disconnect.

### Network permission belongs to the deployer, not the repository

The online baseline is set by the **deployer** (`AGENT_DOCKER_NETWORK_MODE`, default `none`). Neither a repository nor a fork can change it. The repository is a trust subject, not an authority: it cannot grant itself more reach than the deployment allows.

## Other Design Choices

These decisions matter, but they are **not** trust judgments. They are about how the environment is obtained and how the declaration is defined, not about how far each source is trusted. They are kept here so they are not confused with the trust model above.

**Do not bake dependencies into the image.** The workspace image stays an "isolation host + generic engine"; it does not pre-install the reviewed repository's dependencies. The toolchain combinations (language × framework × repository) are unbounded, so prediction is guaranteed to fail — "install uv today, and what tomorrow?".

**Do not run the agent in CI.** A long-running agent runs in its own container, not in GitHub Actions. CI minutes are finite, and a single review with a cold install does not fit. (The *trust* model of hosted CI is reused — see "isolated" above; its *execution* model is not.)

**Use a custom declaration file, not the CI ecosystem's file.** The declaration lives at `.sec-review/setup.yml`. The concrete alternative — and the one worth naming — is to reuse the file the CI ecosystem already has, GitHub Copilot's `.github/workflows/copilot-setup-steps.yml`. It is rejected: the format would not be ours to control, and reading it would mean parsing Actions YAML, extracting only the `run` steps, and deciding what to do with `uses:` — more machinery, for a shape we do not own.

**The declaration runs once per stage, not once per run.** Each review stage gets its own sandbox, so the declaration is executed at the start of every stage that runs (analysis, mitigation, verification), and again for every case in a repository review. This is the price of per-stage container isolation — there is no shared cache across sandboxes, and adding one would re-open the trust and pollution questions the isolation baseline closes. A declaration should therefore be idempotent and reasonably fast; the per-step timeout cap (`SEC_REVIEW_SETUP_STEP_MAX_SECONDS`) bounds a single step, not the number of times it runs.

**Do not guess the install command.** There is no lockfile heuristic and no "detect-only" hint; only an explicit declaration drives the rebuild. Heuristics misfire on multi-language monorepos, private registries, and mixed toolchains (this repository itself is uv + pnpm + npm + cargo), and a convention would auto-execute install scripts from a repository we have not reviewed for that purpose. The rejected alternatives are a convention fallback, on by default, and a detect-and-suggest prompt. The accepted consequence: a repository with no declaration gets an empty environment.
