# Agent MCP

Language: English | [中文](MCP.zh.md)

This page explains how Model Context Protocol (MCP) servers fit into the agent runtime. MCP is an optional source of tools. It does not expand the agent's review or repair scope.

Official references:

- [Model Context Protocol documentation](https://modelcontextprotocol.io/)
- [Model Context Protocol specification and documentation repository](https://github.com/modelcontextprotocol/modelcontextprotocol)

## Role

MCP [server features](https://modelcontextprotocol.io/specification/latest/server/index) include three main protocol primitives:

- [tools](https://modelcontextprotocol.io/specification/latest/server/tools): callable operations, such as querying an advisory database or serving a code index
- [resources](https://modelcontextprotocol.io/specification/latest/server/resources): readable context objects owned by the server
- [prompts](https://modelcontextprotocol.io/specification/latest/server/prompts): reusable prompt templates owned by the server

In practice, many MCP servers expose only tools. Resources and prompts are MCP primitives, but ecosystem support is uneven; for example, the [OpenAI Agents Python issue for prompts/resources support](https://github.com/openai/openai-agents-python/issues/544) reflects a client-side gap where MCP support long centered on tools. The [LangChain forum discussion on MCP prompts/resources](https://forum.langchain.com/t/mcp-prompts-and-resources/178) shows that adapters can read prompts and resources, but that is still only data loading, not an automatic MCP management layer.

In other words, an adapter does not decide:

- which server prompts belong in which agent
- how multiple prompts should be ordered and merged
- how prompt / resource provenance should be recorded
- whether MCP failures should abort or degrade
- how to control [MCP prompt injection](https://mcpmanager.ai/blog/mcp-prompt-injection/) or tool-list bloat

This project currently does not maintain extra usage discipline for each MCP tool, and it does not load MCP server prompts / resources. The model decides whether to call a tool from its name, description, and schema.

## CodeGraph

CodeGraph is special because it must read the repository workspace the agent currently sees.

In this project, `/workspace` is the stable path the agent uses, but the real directory behind it is assembled for the current run / stage / session. CodeGraph needs a reachable absolute workspace path; that path must point to the workspace the agent sees for this session, and tool results must use paths the agent can continue using.

This is why CodeGraph belongs close to the sandbox filesystem. In Docker sandbox mode, enabling CodeGraph means the sandbox image needs to include CodeGraph; see [`workspace-codegraph.Dockerfile`](../../agents/docker/workspace-codegraph.Dockerfile).

## Choosing MCP Tools

Do not add an MCP server only because its domain sounds relevant. A tool should help the current workflow make a better decision based on the repository.

Knowledge tools deserve extra caution. Advisory and vulnerability databases can provide useful facts, but they can also pull the model away from the prepared repository into version ranges, external fixed refs, and broad security descriptions that do not prove the current code is vulnerable or repaired. If the workflow is not responsible for dependency auditing or advisory verification, exposing that tool can add more confusion than signal.

This project tried StacklokLabs' [OSV MCP](https://github.com/StacklokLabs/osv-mcp) integration and removed it. OSV worked as a protocol integration: the model could call the tools and retrieve CVE / GHSA facts. The problem was usefulness for our current agent jobs. In a real issue analyzer probe for [CVE-2024-1724](https://www.cve.org/CVERecord?id=CVE-2024-1724), OSV returned the advisory description, affected ranges, and fixed commit references, but those were not the effective repository evidence the analyzer needed. The issue text already described the CVE, and the affected ranges / fixed refs did not contain useful information for locating the current code defect. Instead, they encouraged the agent to chase git history inside the current checkout. The final run happened to judge that the vulnerability was still present, but it did so by looking at repository version and commit relationships rather than by understanding where the vulnerability was.

Before adding an MCP server, check:

- whether the workflow has a decision that the tool can materially change
- whether the tool encourages a new default responsibility that the agent should not own
- whether the same value is better provided by bash, skills, prepared context, or deterministic pre-processing
- whether the tool substantially overlaps with existing MCP capabilities in a way that adds ambiguity more than value

Related code-intelligence MCP projects:

- [Code Index MCP](https://github.com/johnhuang316/code-index-mcp)
- [Codebase Memory MCP](https://github.com/DeusData/codebase-memory-mcp)

## Adding MCP Integrations

When adding an MCP integration, keep the MCP client / connection helper in the MCP package, and attach it only to agents that need the tool. Do not make runtime attach the tool globally. Document the required environment, sandbox, credentials, or server availability, and decide whether failures should degrade or abort.

Add focused tests showing that the MCP tools can be loaded, environment gates and failure handling behave as expected, and only the intended agent sessions receive the tools. If the value depends on model behavior, use a gated LLM integration or contrast test. Do not load MCP prompts / resources unless the project also defines provenance, merge order, and prompt-injection handling for them.

## Bash + Skills vs. MCP

MCP is not the default answer for every helper capability.

The bash available to agents is sandbox bash. It is suitable for low-side-effect, disposable actions that only touch the current workspace files and command environment: search, build, test, lint, typecheck, temporary indexes, small reproductions, and CLI tools that need to see the same `/workspace` as the agent. Skills can explain how to use those commands without turning the tool into a separate protocol service. From this perspective, CodeGraph is currently used through MCP, but it is also a natural fit for bash + skills.

But bash + skills is not everything.

The first class is obvious: some capabilities simply cannot run through bash.

The second class is subtler: some capabilities can technically be called from bash, but should not run inside sandbox bash. Examples include capabilities that need external identity, long-running services, cross-run state, real side effects, or runner-side trust.

Those cases are better expressed as MCP, runner-side services, or external services.
