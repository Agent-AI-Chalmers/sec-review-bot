# Agent MCP

语言：[English](MCP.md) | 中文

本文是 [MCP.md](MCP.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

本文说明 Model Context Protocol (MCP) server 在 agent runtime 里的位置。MCP 是可选工具来源，不会扩大 agent 可审查或修复的范围。

官方参考：

- [Model Context Protocol documentation](https://modelcontextprotocol.io/)
- [Model Context Protocol specification and documentation repository](https://github.com/modelcontextprotocol/modelcontextprotocol)

## 角色

MCP [server features](https://modelcontextprotocol.io/specification/latest/server/index) 里有三种主要协议原语：

- [tools](https://modelcontextprotocol.io/specification/latest/server/tools)：可调用操作，例如查询 advisory 数据库或提供代码索引
- [resources](https://modelcontextprotocol.io/specification/latest/server/resources)：由 server 拥有的可读上下文对象
- [prompts](https://modelcontextprotocol.io/specification/latest/server/prompts)：由 server 拥有的可复用 prompt template

现实里，很多 MCP server 只暴露 tools。resources / prompts 虽然是 MCP 原语，但生态支持并不均匀；例如 [OpenAI Agents Python 的 prompts/resources 支持 issue](https://github.com/openai/openai-agents-python/issues/544) 反映了 client 侧长期主要暴露 tools 的缺口。[LangChain forum 的 MCP prompts/resources 讨论](https://forum.langchain.com/t/mcp-prompts-and-resources/178) 说明 adapter 可以读取 prompts / resources，但这仍然只是“能取到”，不是自动的 MCP 管理层。

也就是说，adapter 不会替项目决定：

- 哪些 server prompt 应该进入哪个 agent
- 多个 prompt 如何排序和合并
- prompt / resource 的来源如何记录
- MCP 失败时应该中断还是降级
- 如何控制 [MCP prompt injection](https://mcpmanager.ai/blog/mcp-prompt-injection/) 或工具数量膨胀

当前本项目没有为每个 MCP 工具额外维护一套使用纪律；我们也没有加载 MCP server prompts / resources。模型根据 tool name、description 和 schema 判断当前任务是否需要调用。

## CodeGraph

CodeGraph 比较特殊，因为它必须读取 agent 当前看到的 repository workspace。

在本项目里，`/workspace` 是 agent 稳定使用的路径，但它背后对应的真实目录由当前 run / stage / session 组装出来。CodeGraph 需要的是一个可访问的 workspace 绝对路径；这个路径必须指向 agent 当前这次看到的那份 workspace，并且 tool result 里的路径也要能让 agent 继续使用。

这就是为什么 CodeGraph 要贴近 sandbox filesystem。Docker sandbox 模式下启用 CodeGraph，意味着 sandbox image 需要包含 CodeGraph；见 [`workspace-codegraph.Dockerfile`](../../agents/docker/workspace-codegraph.Dockerfile)。

## 选择 MCP 工具

不要因为一个 MCP server 的领域听起来相关，就把它接进 agent。工具应该帮助当前 workflow 更好地基于仓库证据做判断。

本项目试过接入 StacklokLabs 的 [OSV MCP](https://github.com/StacklokLabs/osv-mcp)，后来撤掉了。它作为协议集成是工作的：模型能调用工具，也能拿到 CVE / GHSA facts。问题在于它对我们当前 agent 任务的实际帮助有限。在一次针对 [CVE-2024-1724](https://www.cve.org/CVERecord?id=CVE-2024-1724) 的真实 issue analyzer probe 里，OSV 返回了 advisory 描述、affected ranges 和 fixed commit references，但这些并不是 analyzer 当时真正需要的有效仓库证据。issue text 已经描述了 CVE，affected ranges / fixed refs 也不包含能定位当前代码缺陷的有效信息，反而诱导 agent 认为可以在当前代码库里追 git 历史。最后它意外地判断仍有漏洞，但方法是查看代码库版本和提交关系，而不是真的理解漏洞在哪里。

接入一个 MCP server 前，先检查：

- 当前 workflow 是否有一个这个工具能实质改变的判断
- 这个工具是否会诱导 agent 承担一个本不该默认承担的新职责
- 同样价值是否更适合由 bash、skills、prepared context 或确定性预处理提供
- 这个工具是否会与现有 MCP 能力形成较大重叠，并且带来的模糊性多于实际价值

相关的代码智能 MCP 项目：

- [Code Index MCP](https://github.com/johnhuang316/code-index-mcp)
- [Codebase Memory MCP](https://github.com/DeusData/codebase-memory-mcp)

## 新增 MCP 集成

新增 MCP 集成时，MCP client / connection helper 应该放在专门的 MCP package 里；真正需要该工具的 agent 再调用这些 helper 接入工具。不要让 runtime 全局默认挂载。文档里要说明需要的环境变量、sandbox、凭据或 server 可用性，并明确失败时应该降级还是中断。

增加聚焦测试，证明 MCP tools 能被加载、环境开关和失败处理符合预期，并且只有目标 agent session 能拿到这些 tools。如果价值依赖模型行为，用 gated LLM integration 或 contrast test 验证。除非项目同时定义 provenance、合并顺序和 prompt-injection 处理方式，否则不要加载 MCP prompts / resources。

## Bash + Skills vs. MCP

MCP 不是每个辅助能力的默认答案。

agent 能用的 bash 是 sandbox bash。它适合只作用于当前 workspace 文件和命令环境、低副作用、可以丢弃的动作：搜索、构建、测试、lint、typecheck、临时索引、小型复现，以及需要看到 agent 同一个 `/workspace` 的 CLI。skills 可以说明这些命令该怎么用，而不必把工具包装成单独的协议服务。从这一点来看，CodeGraph 虽然目前是以 MCP 使用的，但是也非常适合 bash + skills。

但是 bash + skills 也不是全部：

第一类很直接：有些能力无法通过 bash 运行。

第二类更微妙：有些能力理论上可以通过 bash 调用，但不应该放进 sandbox bash，比如需要外部身份、长期服务、跨 run 状态、真实副作用或 runner-side 信任环境的能力。

这两类情况更适合 MCP、runner-side service 或 external service，而不是 bash + skills。
