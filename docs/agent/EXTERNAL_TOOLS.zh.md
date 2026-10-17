# Agent 外部工具

语言：[English](EXTERNAL_TOOLS.md) | 中文

本文是 [EXTERNAL_TOOLS.md](EXTERNAL_TOOLS.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

本文说明 agent 使用哪些外部工具，以及这些工具如何进入 runtime。我们首先关注工具带来的能力；CLI、skills 和 Model Context Protocol (MCP) 都只是可能的接入方式，本身不是目标。

## TL;DR

选定的默认外部工具是用于 code property graph 分析的 Joern，以及用于浏览器运行时验证的 Playwright。配置 `AGENT_JOERN_ENABLED=true` 和 `AGENT_PLAYWRIGHT_ENABLED=true` 后，它们通过 bash 和各自的 CLI 暴露给 agent。默认不需要为它们提供 bundled skill。

项目同时保留 MCP 集成框架。CodeGraph 和 Playwright 已为能够使用它们的 agent 提供可选 MCP 配置，但 MCP 默认关闭。这些集成仍可用于开发、实验，以及明确选择 MCP 的部署环境。

## MCP

MCP 是向 model client 暴露能力的协议。它的 [server features](https://modelcontextprotocol.io/specification/latest/server/index) 包含三种主要原语：

- [tools](https://modelcontextprotocol.io/specification/latest/server/tools)：可调用操作
- [resources](https://modelcontextprotocol.io/specification/latest/server/resources)：由 server 持有的可读上下文
- [prompts](https://modelcontextprotocol.io/specification/latest/server/prompts)：由 server 持有的可复用 prompt template

当前本项目只消费 MCP tools，不加载 MCP prompts 或 resources。即使增加 adapter，它也不会自动决定哪些 server instruction 应该进入哪个 agent、instruction 如何合并、来源如何记录，或者 server 内容是否可信。

对于 tools，模型根据暴露的 name、description 和 schema 进行选择。因此每项 MCP 集成都会占用模型上下文，并增加一套进程、transport、生命周期和失败边界。这些成本可能值得承担，但它们不是免费的工具发现机制。

当 MCP 暴露的是 bash 无法准确提供的能力时，它最有价值。例如：由人与 agent 共享的既有应用 session；必须留在 sandbox 外的 credential；无法挂载进 workspace 的 host 资源；或者确实围绕通知和共享实时状态建立的交互操作。

远程、长期运行或有状态，本身不能证明需要 MCP。CLI 同样可以调用远程 API、把 session 保存在文件中并操作长期运行的进程。如果一个 MCP tool 的主要操作接受任意 command、query、script 或 code string，就尤其值得审视，因为它可能只是在包装 agent 已经拥有的能力。

过去的实验也说明，支持协议本身并不足够。本项目试过 StacklokLabs 的 [OSV MCP](https://github.com/StacklokLabs/osv-mcp)，后来将其删除。在一次针对 [CVE-2024-1724](https://www.cve.org/CVERecord?id=CVE-2024-1724) 的 issue-analyzer probe 中，server 返回了正确的 advisory facts，但这些信息无助于定位或理解当前 checkout 中的缺陷。协议是工作的，但能力没有改善 workflow 的判断。

官方参考：

- [Model Context Protocol documentation](https://modelcontextprotocol.io/)
- [Model Context Protocol specification and documentation repository](https://github.com/modelcontextprotocol/modelcontextprotocol)

## 自描述 CLI

可用的 CLI 能够通过命令树、`--help`、结构化输出、退出状态、stdout 和 stderr 说明自己的接口。能够使用 shell 的 agent 可以按需发现这套接口，而不必预先把所有操作都作为 tool schema 放进上下文。当底层能力不需要独立 session、credential 或由 host 持有的状态边界时，CLI 本身便可以构成足够的接入界面。

CLI 不需要自动配套 skill。不要把 command reference 复制进 `SKILL.md`。只有实验表明 agent 反复缺少 CLI 接口以外的知识时，才增加 skill，例如：

- 何时选择或避免该工具
- 不直观的分析 workflow
- 如何区分空结果和分析不完整
- 哪些结果只是线索，哪些结果构成可接受证据
- 已知盲区和必要验证

在出现这类缺口之前，只提示命令存在并允许 agent 查看 `--help`，是更小也更容易维护的集成方式。

## 为什么 Joern 和 Playwright 只使用 CLI

Joern 提供 code property graph、结构查询、调用关系和数据流分析。Playwright 提供浏览器交互和运行时证据。项目选择它们是因为这些能力，而不是因为某种接入协议。

在当前 runtime 中，这两项能力都不要求 MCP：

- Joern 可以通过本地命令和脚本创建并查询分析 project，其有效状态可以作为文件保存在 sandbox 中。
- Playwright CLI 可以持有持续的 browser session、访问 repository setup 启动的服务，并把浏览器观察结果返回给 agent。
- 两个工具都运行在 agent 已经能够使用 bash 的同一个 sandbox 中。
- 两项集成都不需要只能由 host 持有的 credential、既有的人工操作 session，或者无法提供给 sandbox 的 host 资源。

本项目分别通过 `AGENT_JOERN_ENABLED` 和 `AGENT_PLAYWRIGHT_ENABLED` 启用已安装的命令；两者默认均为 false。每类 review agent 会声明自己可以使用哪些外部工具，只有部署开关和 agent 声明同时选中某项工具时，相关提示才会进入上下文。这些开关要求使用具备命令执行能力的 Docker 或 bwrap backend；如果 backend selection 最终落到不能执行命令的 local fallback，配置会直接失败。Docker 部署必须在所选镜像中提供相应命令；bwrap 部署必须在 sandbox 可见的 host 路径中提供它们。

因此，MCP layer 暴露的能力大体相同，却会增加 tool schema 和 connection lifecycle。它尚未证明能够提供默认 workflow 所需的额外能力。选择 CLI 是因为 CLI 已经足够，而不是因为 CLI 在任何场景都优于 MCP。

Skills 对 Joern 和 Playwright 而言是可选的增强，而不是使用这些工具的前提。它们可以在确有帮助时补充 workflow 或结果解释指导，但默认集成不依赖 skills。

Playwright 的 agent prompt 会显式选择 `--browser chromium`。workspace image 安装的是 Playwright Chromium，但 CLI 默认寻找系统 Chrome；当前帮助文本也没有把实际可用的 `chromium` 列在可选值中。这项部署知识目前无法由 `--help` 可靠提供，因此应当进入选中的工具 prompt，而不是另建 skill。

Capability tests 使用显式 `println` marker 固定 Joern query 的证据。Joern 的交互输出包含 ANSI 格式；稳定 marker 让确定性测试能够断言语义值，而不与终端渲染绑定。Agent 正常使用 Joern 时不需要遵循这项约定。

Joern 的 agent prompt 还记录了一项 discovery probe 证明 `--help` 没有安全说明的 CLI 行为：script 接口期待文件，因此 `joern --script /dev/stdin` 可能持续运行而不退出。Agent 的非交互查询应先用 `joern-parse` 创建 CPG，再从可写目录把 `importCpg` 和 query 作为独立的交互输入行管道给 `joern`。Prompt 只保留这项很小的运行约束，其余 query DSL 仍由 agent 自行发现。

## 可选 MCP 集成

虽然本项目不推荐把 MCP 作为默认工具接口，开发者仍然可以接入所需的 MCP。CodeGraph 和 Playwright 已经接入系统，并配置给了相应的 agent；只是由于 `AGENT_MCP_ENABLED` 默认为 `false`，正常运行时不会启用。

新增集成仍然需要说明：与已有 CLI 或 workflow input 相比，它额外提供了什么能力或边界。

MCP client 与 connection helper 应放在 MCP package 中。文档需要说明所需环境、sandbox、credential、server availability、trust boundary 和 failure policy。不要全局挂载 MCP tools。

测试分为不同层次：

- Contract tests 验证加载、schema、环境开关、失败处理与 agent ownership。
- 不依赖模型的 capability tests 验证 transport、执行、状态连续性与可观察结果。
- Gated LLM discovery tests 验证 agent 能否识别何时以及如何使用该能力。
- 只有声称 MCP 比更简单方案改善了 decision quality 时，才需要 paired comparison。

不要用 LLM test 证明确定性的 transport 或 capability 事实。除非项目同时定义 provenance、合并顺序、信任处理与 prompt-injection 防护，否则不要加载 MCP prompts 或 resources。
