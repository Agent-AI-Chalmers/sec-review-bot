# Control Plane UI

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

这是用于查看和处置 Review Runs run、检查执行诊断与 artifact、管理 agent memory，以及阅读执行轨迹的内部控制台。服务端数据只通过该应用的同源 BFF 获取；BFF 持有上游凭据，并仅代理明确白名单内的路由。独立的执行轨迹查看器完全在浏览器中处理上传或粘贴的输入。

## 本地运行

在 `apps/control-plane-ui` 中安装依赖，并启动使用 fixture 的预览：

```bash
pnpm install
pnpm run dev:fixtures
```

打开 Vite 输出的地址，通常是 `http://localhost:5173`。这种模式提供有代表性的 run 和 memory 状态，不需要启动 Review Runs、Memory Catalog、PostgreSQL 或 RustFS。Memory 暂停、恢复、编辑和回滚使用有状态 fixture；memory tree 与执行轨迹操作会返回小型 fixture 附件，因此无需真实存储对象也能验证浏览器下载行为。

fixture server 还提供稳定的全页错误状态，便于进行视觉检查：

- `/memory/revisions/404/tree` 显示 memory tree 预览失败，同时保留 artifact 下载入口。
- `/memory/revisions/404/trajectory` 显示执行轨迹加载失败。
- `/runs/fixture-artifact-load-error/files` 显示 run files 加载失败。

查看器页面完全在浏览器本地运行。它接受项目基于事件的 JSONL 执行轨迹格式和直接导出的 LangGraph message-array JSON，可以上传文件或粘贴内容，输入不会发送到 BFF。对于缺少 tool result ID 的直接消息数组，只有在一条 assistant 消息的调用后紧跟完整且无歧义的结果序列时，查看器才会建立关联。

## 源码布局

该 package 先按运行时划分，再按 browser 功能所有权组织：

```text
browser/
  app/                应用 shell、session UI、preferences 和 theme
  features/
    runs/             run 列表、详情、状态和 Review Runs projections
    memory/           memory 查看和 Memory Catalog projections
    workspace/        runs 与 memory 共用的文件浏览和编辑能力
    trajectory/       执行轨迹的解析与展示
    viewer/           本地执行轨迹查看器页面
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
pnpm run colors:check
pnpm test
pnpm run test:e2e
pnpm run build
```

`pnpm run colors:check` 检查控制台自定义的颜色是否在浅色和深色主题中完整且有效。当前景色与背景色的对比度不足，或品牌色没有按从浅到深排列时，检查会失败；相邻品牌色可能过于接近时只报告提示，不会让命令失败。

`pnpm test` 会运行 Node 测试和 Vitest React 组件测试。组件测试通过 React Testing Library 与 jsdom 验证局部渲染和交互行为。`pnpm run test:e2e` 通过 Playwright Test 运行桌面与移动 Chrome project。本地每个 worker 都会在随机端口启动独立的 fixture server，避免有状态流程在 worker 之间泄漏；调试时可通过 `CONTROL_PLANE_UI_E2E_PORT` 指定固定本地端口。设置 `CONTROL_PLANE_UI_BASE_URL` 后可以测试已经运行的外部部署；该部署需要登录时还需设置 `CONTROL_PLANE_UI_ACCESS_TOKEN`。外部部署测试只读，并使用单 worker，避免针对共享数据成倍增加负载和观测干扰；单 worker 是稳定性策略，不是防止写入的安全边界。浏览器特有的布局、滚动、minimap、下载与请求竞态行为保留在由 Playwright 测试调用的可复用 browser flow 中；组件行为则由 Vitest 覆盖，不在 E2E 中重复断言。

生产服务需要 `REVIEW_RUNS_READ_TOKEN` 和 `CONTROL_PLANE_UI_ACCESS_TOKEN`，它们回答的是两个不同的问题。访问 token 决定"谁能打开控制台"：浏览器用它换取 HTTP-only 会话 cookie，token 本身不会进入浏览器代码或 Vite 变量。read token 则是后端在用户登录后调用 Review Runs 查询路由时使用的凭证，同样只存在于服务端。两者分开，意味着控制台账号与读密钥可以独立签发、轮换和吊销——例如只读的监控面板只持有 read token，不具备任何控制台访问能力。

BFF 还负责代理下载私有 RustFS 中的终态 artifact。它使用单独的 `s3:GetObject` 凭据，该凭据仅可读取 `sec-review/runs/*/artifacts/*`；浏览器只提交 run ID，不会收到存储凭据或对象 URI。BFF 会先将对象写入临时文件，并根据 Review Runs 元数据校验大小和 SHA-256 摘要，再向浏览器返回下载。下载使用同一个 HTTP-only session 鉴权，固定作为附件返回，并受存储空闲超时限制。

服务端 memory tree reader 与 builder 实现版本化的 [memory-tree profile](../../contracts/tar-zstd-artifact/profiles/memory-tree/README.zh.md)。它们不会进入 browser bundle；BFF 负责校验、digest 计算和规范 object key。

设置 `MEMORY_CATALOG_URL` 和 `MEMORY_CATALOG_TOKEN` 后启用 memory 管理。BFF 会从 Catalog JSON 中移除存储 URI，自行读取 artifact，并在返回内容或下载前校验 size 和 SHA-256 digest。

经过认证的 control plane 可以暂停或恢复 maintenance、编辑 active memory tree，以及恢复已有 revision。BFF 在服务端确定 actor identity，并使用 expected active revision 和 control generation 的 compare-and-swap。其 S3 identity 只能在 `memory/trees/*` 下创建不可变对象；run artifact 和 memory 相关执行轨迹仍然只读。编辑或恢复失败后不会自动恢复 maintenance。
