# `@sec-review-bot/github-integration`

Language: English | [中文](README.zh.md)

This package contains the GitHub integration service for the project.

It does not execute agent workflows directly. It prepares inputs, submits and observes review runs through Control Plane, and publishes terminal results back to GitHub.

## Setup

For local development, install the Control Plane service and integration dependencies from the repository root:

```bash
corepack enable pnpm
pnpm --dir control-plane install
pnpm --dir apps/github-integration install
```

Use Node 24.x.

> _Node 24 is the current LTS baseline for this package. The [Node.js release schedule](https://github.com/nodejs/Release#release-schedule) currently lists Node 26's Active LTS start as 2026-10-28; after that, this package can evaluate moving the default runtime to Node 26._

## Commands

```bash
pnpm run dev
pnpm run server
pnpm run format:check
pnpm run lint
pnpm run build
pnpm test
```

`pnpm test` runs tests that do not require external services. The integration
suite uses the Control Plane test database for publisher boundary tests:

```bash
TEST_DATABASE_URL=postgresql://sec_review_bot:password@127.0.0.1:5432/sec_review_bot_test \
pnpm run test:integration
```

## Local Receiver

A complete review also needs the runner service and worker. To run the whole stack locally, use the repository-level Docker Compose deployment. The commands below only start the GitHub integration service.

For non-Compose startup, fill `apps/github-integration/.env` from `apps/github-integration/.env.sample`; at minimum set `APP_ID`, `PRIVATE_KEY_PATH`, `WEBHOOK_SECRET`, `CONTROL_PLANE_SERVICE_URL`, and `CONTROL_PLANE_SERVICE_TOKEN`.

```bash
pnpm run server
```

Development mode:

```bash
pnpm run dev
```

Local URLs:

```text
http://localhost:30000/api/webhook
http://localhost:30000/api/repository-review/dispatch
```

If you do not have a public HTTPS address locally, use `smee`:

```bash
npx smee -u https://smee.io/your-channel -t http://localhost:30000/api/webhook
```

GitHub references:

- GitHub App quickstart:
  - <https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/quickstart>
- GitHub webhook app guide:
  - <https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-github-app-that-responds-to-webhook-events>

If you already have a domain, you can also use Cloudflare Tunnel to route a public address to the local service.

For local GitHub App webhook and Actions dispatch routing, see the [local GitHub inbound setup guide](../../docs/operations/LOCAL_GITHUB_INBOUND_SETUP.md).

## Role

- Read GitHub App metadata and installation identity

- Receive GitHub webhooks
- Receive OIDC-authenticated HTTP dispatches initiated by GitHub Actions

- Prepare issue / pull request review input
- Prepare repository review input

- Submit prepared inputs to Control Plane and claim publication work
- Publish structured results back to GitHub

## Layout

- `reviews/` - input preparation, submission, publishing, and rendering for review workflows
  - `reviews/issues/` - issue review
  - `reviews/pull-requests/` - pull request review and suggestion comments
  - `reviews/repositories/` - repository review, summary issue, and repair draft PR
- `infrastructure/runner/` - Control Plane client, runner input types, input bundle manifest / workspace helpers, and publication worker
- `infrastructure/github/` - thin GitHub API wrappers and webhook helpers
- `interfaces/` - HTTP, GitHub Actions, and GitHub webhook adapters
- `triggers/` - turns webhook / Actions / comment requests into Control Plane review submissions
- `utils/` - lightweight logging and helpers

## Triggers

### Configure automatic triggers

Trigger mode is configured in the target repository's [`.github/sec-review-bot.yml`](../../.github/sec-review-bot.yml).

Config shape:

```yaml
sec_review_bot:
  # Controls automatic PR / issue webhook review.
  #
  # - manual_only: automatic PR / issue events are ignored;
  #   only explicit comment commands from repository write+ users trigger reviews.
  # - automatic: dangerous mode. PR / issue events from any author trigger
  #   reviews without maintainer approval and can spend runner / LLM resources.
  trigger_mode: manual_only

  # Optional repository discovery ignore patterns (glob)
  # Semantics follow CodeQL-style paths-ignore.
  paths_ignore:
    - 'frontend/src/assets'
    - '**/*.min.js'
    - 'node_modules'
```

Semantics:

- `trigger_mode: manual_only`: automatic object events are received and skipped; only explicit comment commands from repository `write`, `maintain`, or `admin` users trigger workflows.
- `trigger_mode: automatic`: dangerous mode. PR / issue events such as `pull_request.opened`, `pull_request.ready_for_review`, and `issues.opened` trigger workflows for any author, including users without repository write access. It can spend runner / LLM resources without maintainer approval.

Notes:

- [`.github/workflows/sec-review-bot.yml`](../../.github/workflows/sec-review-bot.yml) contains GitHub Actions scheduling only; bot runtime configuration belongs in `.sec-review-bot.yml`.
- If [`.github/sec-review-bot.yml`](../../.github/sec-review-bot.yml) is missing, the default behavior is `trigger_mode: manual_only`.
- If the config file exists but the YAML is invalid, `sec_review_bot.trigger_mode` is missing, or the value is not allowed, automatic webhooks fail strictly instead of silently downgrading.
- `paths_ignore` only affects repository-review discovery file scanning. It does not affect PR/Issue webhook trigger decisions.
- Repository config does not support selecting a workspace image. The GitHub integration does not parse image configuration fields from `.github/sec-review-bot.yml`.

### Manual commands

`<app-slug>` is not a literal placeholder; it is the actual slug registered for the GitHub App. If the app slug is `web-sec-bot`, the real comment is `@web-sec-bot review repair`.

Normal issue comments support:

```text
@<app-slug> review audit
@<app-slug> review repair
@<app-slug> review repair no-test-changes
```

Writing only `@<app-slug> review` on a normal issue does not trigger a workflow because the system cannot tell whether you want to audit the input first or proceed with repair intent.

Issue comments support three modes:

- `review audit`: first audit whether the issue input corresponds to a repairable security problem in the current repository; only enter repair after confirming a repairable target.
- `review repair`: the user has expressed repair intent. After analyzer, the workflow enters the repair stage and attempts to produce a patch. If repair is inapplicable or coverage is insufficient, the result explains why. By default, the final patch may contain reasonable test changes.
- `review repair no-test-changes`: also expresses repair intent, but the final patch should not contain test changes. Tests may only be used as temporary validation work.

Automatic issue triggers use `audit` because no human has explicitly decided "please fix this" yet.

PR Conversation comments support:

```text
@<app-slug> review
@<app-slug> review no-test-changes
```

PR command meanings:

- `review`: triggers PR review. By default, the final patch may contain reasonable test changes.
- `review no-test-changes`: also triggers PR review, but the final patch should not contain test changes. Tests may only be used as temporary validation work.

### Repository-level Actions trigger

Repository-level review is triggered through [`.github/workflows/sec-review-bot.yml`](../../.github/workflows/sec-review-bot.yml) with `workflow_dispatch` or `schedule`, not through comment commands.

![GitHub Actions repository review workflow dispatch form](../../assets/screenshots/github-actions-repository-review-dispatch.png)

The target repository must configure these Actions secrets:

- `SEC_BOT_DISPATCH_URL`: the full public HTTPS URL for the App dispatch endpoint, for example `https://your-bot-dev.example.com/api/repository-review/dispatch`

Repository-level dispatch uses GitHub Actions OIDC. The workflow must grant `id-token: write`, and the token audience is fixed to `sec-review-bot`.

Manual `workflow_dispatch` supports:

- `scan_mode`: `full` or `incremental`
- `base_sha`: required for manual incremental scans
- `head_sha`: optional for manual incremental scans; defaults to the current branch HEAD
- `repair_mode`: `test-changes-allowed` or `no-test-changes`

`repair_mode=no-test-changes` means the final patch generated by repository-level scans should not contain test changes. Tests may still be used as temporary validation work. `schedule` triggers without manual input use the default repair mode.

`schedule` triggers default to incremental scan, and the App derives the scan window from the cron schedule. Manual incremental scans must explicitly provide `base_sha`.

Additional notes:

- Manual commands are accepted from normal issue comments and comments on the Pull Request page's Conversation tab.
- Comments on the Files changed page and review comments submitted through Submit review are outside the supported command surface.

## GitHub REST API Version

- By default, `X-GitHub-Api-Version` is pinned to `2026-03-10` to avoid falling back to soon-to-be-removed compatibility paths.
- Override it with `GITHUB_API_VERSION` when debugging or rolling out an API version change.
- Version docs: <https://docs.github.com/en/rest/about-the-rest-api/api-versions?apiVersion=2026-03-10>

## Bot-Originated Events And Publishing

Comments, PRs, or pushes created by the bot itself may trigger webhooks again and create a loop. The webhook entrypoint checks whether the sender is the bot and skips matching events. Only events produced by this App itself are skipped.

Manual comment command parsing also ignores Markdown blockquote lines, so quoting an older bot command in a reply does not retrigger that command. A new command must appear outside the quoted text.

Publishing has one related guard: when the current App bot authored the PR, the App publishes a normal review comment instead of creating `APPROVE` or `REQUEST_CHANGES` reviewer state for itself. If GitHub still rejects an approval as an own-PR review, the publisher falls back to a normal review comment.
