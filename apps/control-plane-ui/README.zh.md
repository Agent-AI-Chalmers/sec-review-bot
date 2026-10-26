# Control Plane UI

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

这是用于查看 Review Runs run 和操作 memory 的内部控制台。浏览器只访问该应用的同源服务端；服务端持有上游凭据，并仅代理明确白名单内的路由。

## 本地运行

在 `apps/control-plane-ui` 中安装依赖，并启动使用 fixture 的预览：

```bash
pnpm install
pnpm run dev:fixtures
```

打开 Vite 输出的地址，通常是 `http://localhost:5173`。这种模式提供有代表性的 run 和 memory 状态，不需要启动 Review Runs、Memory Catalog、PostgreSQL 或 RustFS。Memory 暂停、恢复、编辑和回滚使用有状态 fixture；artifact 下载链接背后没有真实存储对象。

## 源码布局

该 package 先按运行时划分，再按 browser 功能所有权组织：

```text
browser/
  app/                应用 shell、session UI、preferences 和 theme
  features/
    runs/             run 列表、详情、状态和 Review Runs projections
    memory/           memory 查看和 Memory Catalog projections
    workspace/        runs 与 memory 共用的文件浏览和编辑能力
    transcript/       transcript model 和 renderer
    viewer/           本地 transcript viewer 页面
  shared/             仅供 browser 使用的基础设施和小型工具
  styles/             按顺序加载的样式分区
  main.tsx            browser 入口
server/               Node BFF
shared/               browser 与 server 都会 import 的值
scripts/              开发期 package 工具
test/                 browser 与 server 测试
```

功能域之间不得相互 import。可复用的 browser 能力放在 `browser/features/` 或 `browser/shared/`；包级 `shared/` 仅用于真正跨越 browser/server 运行时边界的代码。

fixture 按 Review Runs 的默认页大小提供数十条 run，并实现了它的游标契约，因此翻页、状态筛选和详情时间线都能在没有后端的情况下走通。每条生成的 run 都会对照 store 实际可能产生的状态做校验，所以不可能出现的组合会让模块导入直接失败，而不是变成看起来合理的演示数据。

如需连接正在运行的 Review Runs，先在一个终端中构建并启动 BFF：

```bash
pnpm run build
REVIEW_RUNS_READ_TOKEN=local-read-token \
CONTROL_PLANE_UI_ACCESS_TOKEN=local-ui-token \
pnpm run server
```

再在另一个终端中启动 Vite：

```bash
pnpm run dev
```

Vite 会将 `/api` 请求代理到 `http://127.0.0.1:8091` 上的 BFF。BFF 默认连接 `http://127.0.0.1:8090` 上的 Review Runs；若 Review Runs 位于其他地址，请设置 `REVIEW_RUNS_URL`。下载 artifact 还需要配置[本地集成部署](../../docs/operations/LOCAL_INTEGRATED_DEPLOYMENT.zh.md)中列出的 S3 参数。AWS 可以使用默认 endpoint 和 `SEC_REVIEW_ARTIFACT_S3_ADDRESSING_STYLE=auto`；本地 RustFS 部署会提供 endpoint 并使用 `path`。

使用完整 Compose 部署时，默认访问地址为 `http://127.0.0.1:8091`。

## 本地检查

```bash
pnpm run lint
pnpm run format:check
pnpm run typecheck
pnpm test
pnpm run build
```

生产服务需要 `REVIEW_RUNS_READ_TOKEN` 和 `CONTROL_PLANE_UI_ACCESS_TOKEN`，它们回答的是两个不同的问题。访问 token 决定"谁能打开控制台"：浏览器用它换取 HTTP-only 会话 cookie，token 本身不会进入浏览器代码或 Vite 变量。read token 则是后端在用户登录后调用 Review Runs 查询路由时使用的凭证，同样只存在于服务端。两者分开，意味着控制台账号与读密钥可以独立签发、轮换和吊销——例如只读的监控面板只持有 read token，不具备任何控制台访问能力。

BFF 还负责代理下载私有 RustFS 中的终态 artifact。它使用单独的 `s3:GetObject` 凭据，该凭据仅可读取 `sec-review/runs/*/artifacts/*`；浏览器只提交 run ID，不会收到存储凭据或对象 URI。BFF 会先将对象写入临时文件，并根据 Review Runs 元数据校验大小和 SHA-256 摘要，再向浏览器返回下载。下载使用同一个 HTTP-only session 鉴权，固定作为附件返回，并受存储空闲超时限制。

服务端 memory tree reader 与 builder 实现版本化的 [memory-tree profile](../../contracts/tar-zstd-artifact/profiles/memory-tree/README.zh.md)。它们不会进入 browser bundle；BFF 负责校验、digest 计算和规范 object key。

设置 `MEMORY_CATALOG_URL` 和 `MEMORY_CATALOG_TOKEN` 后启用 memory 管理。BFF 会从 Catalog JSON 中移除存储 URI，自行读取 artifact，并在返回内容或下载前校验 size 和 SHA-256 digest。

经过认证的 control plane 可以暂停或恢复 maintenance、编辑 active memory tree，以及恢复已有 revision。BFF 在服务端确定 actor identity，并使用 expected active revision 和 control generation 的 compare-and-swap。其 S3 identity 只能在 `memory/trees/*` 下创建不可变对象；run artifact 和 memory transcript 仍然只读。编辑或恢复失败后不会自动恢复 maintenance。
