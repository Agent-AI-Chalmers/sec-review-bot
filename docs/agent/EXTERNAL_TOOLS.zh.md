# Agent 外部工具

语言：[English](EXTERNAL_TOOLS.md) | 中文

本文为 [EXTERNAL_TOOLS.md](EXTERNAL_TOOLS.md) 的中文译文；如有差异，以英文版为准。

本文说明 Agent 使用哪些外部工具，以及它们如何接入运行环境。选择工具首先看它提供什么能力，再决定使用命令行、Skill 还是 Model Context Protocol（MCP）接入。

## 要点

项目提供 Joern 代码属性图（Code Property Graph，CPG）分析和 Playwright 浏览器验证两类可选能力。镜像安装相应工具后，可用 `AGENT_JOERN_ENABLED=true`、`AGENT_PLAYWRIGHT_ENABLED=true` 启用；声明支持该工具的 Agent 会获得 CLI 使用提示，并通过 bash 调用命令。它们不依赖额外的内置 Skill。

项目同时保留 MCP 集成框架。CodeGraph 和 Playwright 已为能够使用它们的 Agent 提供可选 MCP 配置，但 MCP 默认关闭。这些集成仍可用于开发、实验，以及明确选择 MCP 的部署环境。

## MCP

MCP 是向模型客户端提供工具和上下文的协议。它的 [server features](https://modelcontextprotocol.io/specification/latest/server/index) 包含三种主要原语：

- [tools](https://modelcontextprotocol.io/specification/latest/server/tools)：可调用操作
- [resources](https://modelcontextprotocol.io/specification/latest/server/resources)：由服务端提供的可读上下文
- [prompts](https://modelcontextprotocol.io/specification/latest/server/prompts)：由服务端提供的可复用提示词模板

本项目只使用 MCP tools，不加载 MCP prompts 或 resources。即使增加 adapter，它也不会自动决定哪些 server instruction 应该进入哪个 Agent、instruction 如何合并、来源如何记录，或者 server 内容是否可信。

对于 tools，模型根据暴露的 name、description 和 schema 进行选择。因此每项 MCP 集成都会占用模型上下文，并增加一套进程、transport、生命周期和失败边界。这些成本可能值得承担，但通过 MCP 发现工具并非没有代价。

当 MCP 暴露的是 bash 无法准确提供的能力时，它最有价值。例如：由人与 Agent 共享的既有应用 session；必须留在 sandbox 外的 credential；无法挂载进工作区的 host 资源；或者确实围绕通知和共享实时状态建立的交互操作。

远程、长期运行或有状态，本身不能证明需要 MCP。CLI 同样可以调用远程 API、把 session 保存在文件中并操作长期运行的进程。如果一个 MCP tool 的主要操作接受任意 command、query、script 或 code string，就尤其值得审视，因为它可能只是在包装 Agent 已经拥有的能力。

过去的实验也说明，支持协议本身并不足够。本项目试过 StacklokLabs 的 [OSV MCP](https://github.com/StacklokLabs/osv-mcp)，后来将其删除。在一次针对 [CVE-2024-1724](https://www.cve.org/CVERecord?id=CVE-2024-1724) 的 issue-analyzer probe 中，server 返回了正确的 advisory facts，但这些信息无助于定位或理解当前 checkout 中的缺陷。协议本身运行正常，但这项能力没有改善工作流的判断。

官方参考：

- [Model Context Protocol documentation](https://modelcontextprotocol.io/)
- [Model Context Protocol specification and documentation repository](https://github.com/modelcontextprotocol/modelcontextprotocol)

## 自描述 CLI

CLI 可以通过子命令、`--help`、结构化输出、退出状态、标准输出和标准错误说明接口。能够使用 shell 的 Agent 可以按需发现这套接口，而不必预先把所有操作都作为 tool schema 放进上下文。当底层能力不需要独立 session、credential 或由 host 持有的状态边界时，CLI 本身便可以构成足够的接入界面。

接入 CLI 不意味着必须添加 Skill。不要把命令参考手册复制进 `SKILL.md`。只有实验表明 Agent 反复缺少 CLI 接口以外的知识时，才增加 skill，例如：

- 何时选择或避免该工具
- 不直观的分析工作流
- 如何区分空结果和分析不完整
- 哪些结果只是线索，哪些结果构成可接受证据
- 已知盲区和必要验证

在出现这类缺口之前，只提示命令存在并允许 Agent 查看 `--help`，是更小也更容易维护的集成方式。

## 为什么 Joern 和 Playwright 只使用 CLI

Joern 提供代码属性图、结构查询、调用关系和数据流分析；Playwright 提供浏览器交互和运行时证据。

现有受开关控制的验证案例证明了工具可用、Agent 能调用它们，并未证明能普遍改善审查结果。真实仓库对比既有中性、负面结果，也有补充图分析证据的结果。因此，保留 Joern 是因为它提供独立的分析能力，不代表启用它就能稳定提高 Agent 成功率。

在当前运行时中，这两项能力都不要求 MCP：

- Joern 可以通过本地命令和脚本创建并查询分析 project，其有效状态可以作为文件保存在 sandbox 中。
- Playwright CLI 可以持有持续的 browser session、访问 repository setup 启动的服务，并把浏览器观察结果返回给 Agent。
- 两个工具都运行在 Agent 已经能够使用 bash 的同一个 sandbox 中。
- 两项集成都不需要只能由 host 持有的 credential、既有的人工操作 session，或者无法提供给 sandbox 的 host 资源。

本项目分别通过 `AGENT_JOERN_ENABLED` 和 `AGENT_PLAYWRIGHT_ENABLED` 启用已安装的命令；两者默认均为 false。每类 review Agent 会声明自己可以使用哪些外部工具，只有部署开关和 Agent 声明同时选中某项工具时，相关提示才会进入上下文。Joern 和 Playwright 使用 Docker 执行 backend。browser session 和 setup service 在多次命令之间保留在同一个容器中。如果选中的工具与最终 backend 不兼容，配置会直接失败。Docker 部署必须在所选镜像中提供相应命令。

因此，MCP layer 暴露的能力大体相同，却会增加 tool schema 和 connection lifecycle。它尚未证明能够提供默认工作流所需的额外能力。默认使用 CLI 是因为它在这里已经足够，并不表示 CLI 在所有场景都优于 MCP。

Skill 对 Joern 和 Playwright 是可选的，Agent 不需要 Skill 也能使用这两个工具。Skill 可以在确有帮助时补充工作流或结果解释指导，但默认集成不依赖 skills。

Playwright 的 Agent 提示词会显式选择 `--browser chromium`。工作区镜像安装的是 Playwright Chromium，但 CLI 默认寻找系统 Chrome；当前帮助文本也没有把实际可用的 `chromium` 列在可选值中。这项部署知识目前无法由 `--help` 可靠提供，因此应当进入选中的工具提示词，而不是另建 skill。

Capability tests 使用显式 `println` marker 固定 Joern query 的证据。Joern 的交互输出包含 ANSI 格式；稳定 marker 让确定性测试能够断言语义值，而不与终端渲染绑定。Agent 正常使用 Joern 时不需要遵循这项约定。

Joern 的 Agent 提示词还记录了一项通过 discovery probe 发现、但 `--help` 未说明的 CLI 行为：script 接口期待文件，因此 `joern --script /dev/stdin` 可能持续运行而不退出。Agent 的非交互查询应先用 `joern-parse` 创建 CPG，再从可写目录把 `importCpg` 和 query 作为独立的交互输入行管道给 `joern`。Prompt 只保留这项很小的运行约束，其余 query DSL 仍由 Agent 自行发现。

## 可选 MCP 集成

虽然本项目不推荐把 MCP 作为默认工具接口，开发者仍然可以接入所需的 MCP。CodeGraph 和 Playwright 已经接入系统，并配置给了相应的 Agent；只是由于 `AGENT_MCP_ENABLED` 默认为 `false`，正常运行时不会启用。

新增集成仍然需要说明：与已有 CLI 或 workflow input 相比，它额外提供了什么能力或边界。

MCP client 与 connection helper 应放在 MCP 包中。文档需要说明所需环境、sandbox、credential、server availability、trust boundary 和 failure policy。不要全局挂载 MCP tools。

测试分为不同层次：

- Contract tests 验证加载、schema、环境开关、失败处理与 Agent ownership。
- 不依赖模型的 capability tests 验证 transport、执行、状态连续性与可观察结果。
- Gated LLM discovery tests 验证 Agent 能否识别何时以及如何使用该能力。
- 只有声称 MCP 比更简单方案改善了 decision quality 时，才需要 paired comparison。

不要用 LLM test 证明确定性的 transport 或 capability 事实。除非项目同时定义 provenance、合并顺序、信任处理与 prompt-injection 防护，否则不要加载 MCP prompts 或 resources。
