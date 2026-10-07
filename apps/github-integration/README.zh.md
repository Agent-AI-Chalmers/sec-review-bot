# `@sec-review-bot/github-integration`

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

这个 package 是项目里的 GitHub integration service。

它不直接执行 agent workflow；它负责准备输入、提交 runner run、轮询结果，并把结果发布回 GitHub。

## 安装

本地开发时，在仓库根目录安装 Control Plane 服务和 integration 的依赖：

```bash
corepack enable pnpm
pnpm --dir control-plane install
pnpm --dir apps/github-integration install
```

请使用 Node 24.x。

> *Node 24 是当前 package 的 LTS 基线。[Node.js release schedule](https://github.com/nodejs/Release#release-schedule) 当前把 Node 26 的 Active LTS start 列为 2026-10-28；到那之后，可以评估把默认 runtime 切到 Node 26。*

## 命令

```bash
pnpm run dev
pnpm run server
pnpm run lint
pnpm run build
pnpm test
```

`pnpm test` 运行不依赖外部服务的测试。集成测试使用 Control Plane 测试数据库验证 publisher 边界：

```bash
TEST_DATABASE_URL=postgresql://sec_review_bot:password@127.0.0.1:5432/sec_review_bot_test \
pnpm run test:integration
```


## 本地接收端

完整 review 还需要 runner service 和 worker。要在本地跑完整链路，请使用仓库级 Docker Compose 部署。下面的命令只启动 GitHub integration service。

非 Compose 启动时，先按 `apps/github-integration/.env.sample` 填好 `apps/github-integration/.env`；至少需要设置 `APP_ID`、`PRIVATE_KEY_PATH`、`WEBHOOK_SECRET` 和 `AGENT_RUNNER_SERVICE_URL`。任何非 loopback runner service URL，或 runner service 要求 token 时，都需要设置 `AGENT_RUNNER_SERVICE_TOKEN`。

```bash
pnpm run server
```

开发态：

```bash
pnpm run dev
```

本地 URL：

```text
http://localhost:30000/api/webhook
http://localhost:30000/api/repository-review/dispatch
```

如果本地没有公网 HTTPS 地址，可以用 `smee`，如：

```bash
npx smee -u https://smee.io/your-channel -t http://localhost:30000/api/webhook
```

GitHub 参考：

- GitHub App quickstart:
  - <https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/quickstart>
- GitHub webhook app guide:
  - <https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-github-app-that-responds-to-webhook-events>

如果你已经有域名，也可以用 Cloudflare Tunnel 把公网地址转到本地服务。

GitHub App webhook 和 Actions dispatch 的本地转发说明见 [本地 GitHub 入站设置](../../docs/operations/LOCAL_GITHUB_INBOUND_SETUP.zh.md)。

## 职责

- 读取 GitHub App 元信息与 installation 身份

- 接收 GitHub webhook
- 接收 GitHub Actions 发起、通过 OIDC 鉴权的 HTTP dispatch

- 准备 issue / pull request review input
- 准备 repository review input

- 调用 HTTP Agent Runner Service
- 把结构化结果发布回 GitHub

## 目录

- `reviews/` - 各类 review workflow 的输入准备、提交、发布与渲染
  - `reviews/issues/` - issue review
  - `reviews/pull-requests/` - PR review、建议评论
  - `reviews/repositories/` - repository review、摘要 issue 与修复 draft PR
- `infrastructure/runner/` - HTTP runner client、runner input 类型、input bundle manifest / workspace helper、PostgreSQL 协调状态、后台 publisher
- `infrastructure/github/` - GitHub API 薄封装和 webhook 辅助函数
- `interfaces/` - HTTP、GitHub Actions 和 GitHub webhook adapter
- `triggers/` - 把 webhook / Actions / comment 请求转换为 runner review run
- `utils/` - 轻量日志与辅助函数

## 触发

### 配置自动触发

触发模式配置在目标仓库的 [`.github/sec-review-bot.yml`](../../.github/sec-review-bot.yml)。

配置格式：

```yaml
sec_review_bot:
  # 控制 PR / issue webhook 自动触发。
  #
  # - manual_only: 不响应自动 PR / issue 事件；
  #   只有仓库 write+ 用户的显式 comment 命令会触发 review。
  # - automatic: 危险模式。任意作者的 PR / issue 事件都会自动触发 review，
  #   无需维护者确认，并可能消耗 runner / LLM 资源。
  trigger_mode: manual_only

  # 可选：repository discovery 阶段忽略路径（glob）
  # 行为参考 CodeQL 的 paths-ignore
  paths_ignore:
    - 'frontend/src/assets'
    - '**/*.min.js'
    - 'node_modules'
```

配置含义如下：

- `trigger_mode: manual_only`：自动对象事件会被接收后跳过，只有仓库 `write`、`maintain` 或 `admin` 用户在 comment 中显式写出对应手动命令才会触发 workflow。
- `trigger_mode: automatic`：危险模式。`pull_request.opened`、`pull_request.ready_for_review`、`issues.opened` 等事件会为任意作者触发 workflow，包括没有仓库写权限的用户。它无需维护者确认就可能消耗 runner / LLM 资源。

说明：

- [`.github/workflows/sec-review-bot.yml`](../../.github/workflows/sec-review-bot.yml) 仅用于 GitHub Actions 调度，不再承载 bot 的运行配置。
- 如果 [`.github/sec-review-bot.yml`](../../.github/sec-review-bot.yml) 文件不存在，默认行为是 `trigger_mode: manual_only`。
- 如果配置文件存在但 YAML 非法、缺少 `sec_review_bot.trigger_mode` 或值不在允许集合内，自动 webhook 会严格报错并失败（不会静默降级）。
- `paths_ignore` 仅影响 repository-review 的 discovery 文件扫描；不影响 PR/Issue webhook 触发判定本身。
- 仓库配置不支持选择 workspace image。GitHub App 不会从 `.github/sec-review-bot.yml` 解析 image 配置字段。

### 手动命令

这里的 `<app-slug>` 不是字面量占位符，而是这只 GitHub App 在 GitHub 上注册的实际 slug。假设 app slug 是 `web-sec-bot`，那么 comment 里的实际写法就是 `@web-sec-bot review repair`。

普通 issue comment 支持：

```text
@<app-slug> review audit
@<app-slug> review repair
@<app-slug> review repair no-test-changes
```

普通 issue 上单独写 `@<app-slug> review` 不会触发 workflow，因为系统无法判断你想先审计输入，还是直接按修复意图推进。

issue comment 支持三种模式：

- `review audit`：先审计 issue 输入是否对应当前仓库里的可修复安全问题；只有确认可修复目标后才进入修复阶段。
- `review repair`：用户已经表达修复意图；workflow 在 analyzer 后进入修复阶段，尝试生成 patch；如果修复不适用或覆盖不足，结果会明确说明原因。默认允许最终 patch 包含合理的测试改动。
- `review repair no-test-changes`：同样表达修复意图，但最终 patch 不应包含测试改动；测试只能作为临时验证手段。

自动 issue 触发使用 `audit`，因为自动触发时还没有人明确做出“请修”的决断。

PR Conversation comment 支持：

```text
@<app-slug> review
@<app-slug> review no-test-changes
```

PR 命令含义：

- `review`：触发 PR review，默认允许最终 patch 包含合理的测试改动。
- `review no-test-changes`：同样触发 PR review，但最终 patch 不应包含测试改动；测试只能作为临时验证手段。

### 仓库级 Actions 触发

仓库级 review 通过 [`.github/workflows/sec-review-bot.yml`](../../.github/workflows/sec-review-bot.yml) 的 `workflow_dispatch` 或 `schedule` 触发，不使用 comment 命令。

![GitHub Actions repository review workflow dispatch form](../../assets/screenshots/github-actions-repository-review-dispatch.png)

目标仓库必须配置这些 Actions secrets：

- `SEC_BOT_DISPATCH_URL`：App dispatch endpoint 的完整公网 HTTPS URL，例如 `https://your-bot-dev.example.com/api/repository-review/dispatch`

Repository-level dispatch 使用 GitHub Actions OIDC。workflow 必须授予 `id-token: write`，token audience 固定为 `sec-review-bot`。

手动 `workflow_dispatch` 支持：

- `scan_mode`：`full` 或 `incremental`
- `base_sha`：手动增量扫描必填
- `head_sha`：手动增量扫描可选，默认当前分支 HEAD
- `repair_mode`：`test-changes-allowed` 或 `no-test-changes`

`repair_mode=no-test-changes` 表示仓库级扫描生成的最终 patch 不应包含测试改动；测试仍可作为临时验证手段。`schedule` 触发不带手动 input 时使用默认修复模式。

`schedule` 触发默认按 incremental scan 处理，并由 App 侧根据 cron 推导扫描窗口；手动 incremental 必须显式提供 `base_sha`。

补充说明：

- comment 手动命令目前只支持普通 issue comment 和 pull request 页面 Conversation 标签下的 comment
- 暂不支持：Files changed 页面里的评论和 Submit review 时提交的 review 评论。

## Review 生命周期

Webhook 或 Actions dispatch 只等待 integration 完成校验并持久化接纳请求。Workspace 准备、agent 执行和 GitHub 发布都在入口请求路径之外继续进行。

```mermaid
flowchart LR
  ingress[GitHub webhook 事件或 Actions HTTP 请求]
  subgraph integration[GitHub integration]
    admission[校验并持久化接纳]
    preparation[准备 workspace 和 runner input]
    publication[轮询、校验并发布结果]
    admission --> preparation
  end
  ingress --> admission
  admission -.-> acknowledgement[Webhook 成功响应<br/>或 Actions 202 Accepted]
  preparation --> runner[Python Runner 和 Temporal<br/>执行 agent workflow]
  runner --> publication
  publication --> output[GitHub issue、comment、review 或 pull request]
```

GitHub integration 负责完整的 `review_runs` 生命周期。Python 和 Temporal 负责执行 agent workflow，但不负责 GitHub 发布状态。

### 数据库 schema 版本

PostgreSQL 协调 schema 由 `control-plane/src/database/schema-versions` 所有。已执行版本及其 SHA-256 checksum 记录在 `schema_versions`。不要修改已经执行过的版本文件；应新增下一个编号的 SQL 文件，并在 `control-plane/src/database/schema-version-runner.ts` 中注册。Control Plane 启动时使用 PostgreSQL advisory lock 串行执行 schema 变更，如果文件 checksum 与数据库账本不一致则拒绝启动。

### 接纳与重放身份

Webhook 使用 GitHub Delivery ID；Actions dispatch 使用 OIDC 验证的 repository 和 `correlation_id`（当前为 `GITHUB_RUN_ID`）。入口身份写入 `review_runs`，并映射到唯一 `run_id`。

对于 Actions dispatch，HTTP `202 Accepted` 只表示 integration 已经校验并持久化请求；它不表示 agent workflow 或 GitHub 发布已经完成。Webhook 的成功响应也只表示同一件事。

状态分别记录在以下三张表中：

| 表 | 记录内容 | 状态 |
| --- | --- | --- |
| `review_runs` | Runner 观察 | `preparing`、`recovering`、`queued`、`running`、`failed` |
| `publications` | 发布占用 | `pending`、`publishing`、`published`、`failed`、`not_required` |
| `publication_steps` | 单个 GitHub 副作用 | `pending`、`running`、`succeeded`、`failed`、`terminal_failed` |

`ReviewRunStatus` 是 store 的合并投影：publication 开始前显示 Runner 状态，之后显示 publication 状态。它不是数据库字段；step 状态不并入其中。

```mermaid
flowchart LR
  preparing --> queued --> running --> publishing --> published
  preparing --> failed
  failed -->|提交状态不确定| recovering
  recovering --> queued
  queued --> failed
  running --> failed
  publishing -->|确定性失败| failed
  publishing -->|可重试的步骤失败| queued
```

`preparing` 从请求被持久化接纳时开始，早于 workspace 或 input 准备。`recovering` 表示 publisher 已独占领取一次状态不确定的 Runner submission。Publication ownership 和每个 step 的 attempts 与 Runner observation 分开存储。Runner 确定性失败会把 publication 标为 `not_required`，不会进入 GitHub 发布。

| 持久化 run 状态 | 含义 | Publisher 行为 |
| --- | --- | --- |
| `preparing` | 请求已经接纳，但 workspace 和 runner input 仍在准备。 | 不会进入 runner 轮询。 |
| `recovering` | Publisher 正在安全地重放一次响应丢失的 Runner 请求。 | 同一时间只有一个 publisher 持有 recovery claim；过期 claim 可以被重新领取。 |
| `queued` | Runner run 已提交，但尚未观察到运行中状态。 | 继续轮询 runner service。 |
| `running` | Runner service 报告 run 仍在执行。 | 继续轮询。 |
| `publishing` | 某个 publisher 已领取完成的 run，准备执行 GitHub side effects。 | 除非领取已过期，否则其他 publisher 不应再次领取。 |
| `published` | GitHub 发布完成。 | 终态。 |
| `failed` | preparation、submission、Runner execution 或确定性的结果处理失败。 | 通常是终态；`failure_code` 为 `SUBMISSION_STATE_UNCERTAIN` 时由后台自动恢复。 |

可重试的 publication 失败会把 publication 归还 pending。只有失败的 step 消耗自己的 attempt；Runner 轮询失败不消耗 publication attempt。

Repository 发布中，确定性失败只终止当前 delivery；瞬时失败在下一轮从未完成的 step 继续。所有 delivery step 结束后才发布 summary，summary 只链接成功的 delivery。

> 当前重试策略很简单：后台 publisher 启动时会立刻轮询一次，之后按 `AGENT_RUNNER_BACKGROUND_POLL_INTERVAL_MS` 间隔轮询，默认 15 秒。这里还没有指数退避调度。

## GitHub REST API 版本

- 默认通过 `X-GitHub-Api-Version` 固定到 `2026-03-10`，避免落到即将移除的旧兼容路径。
- 可通过环境变量 `GITHUB_API_VERSION` 覆盖（例如在排查或灰度升级时）。
- 版本说明文档：<https://docs.github.com/en/rest/about-the-rest-api/api-versions?apiVersion=2026-03-10>

## Bot 自身事件与发布边界

Bot 自己创建的 comment、PR 或 push 可能会再次触发 webhook，形成自循环。系统在 webhook 入口检查 sender 是否为 Bot，命中后直接跳过，只跳过本 App 自己发出的回流事件。

手动 comment 命令解析也会忽略 Markdown blockquote 行，所以在回复里引用旧 bot 命令不会再次触发；新的命令必须写在引用文本之外。

发布阶段也有一个相关边界：如果 PR 作者是当前 App bot，App 会发布普通 review comment，而不是给自己的 PR 创建 `APPROVE` 或 `REQUEST_CHANGES` reviewer state。如果 GitHub 仍然以 own-PR review 拒绝 approval，publisher 会降级为普通 review comment。
