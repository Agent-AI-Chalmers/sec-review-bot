# Agent External Tools

Language: English | [中文](EXTERNAL_TOOLS.zh.md)

This page explains which external tools the agent uses and how those tools enter the runtime. Tool capability comes first; CLI, skills, and Model Context Protocol (MCP) are possible interfaces rather than goals of their own.

## TL;DR

The chosen default external tools are Joern for code property graph analysis and Playwright for browser-based runtime validation. They will be exposed through bash and their CLIs. The runtime only needs to advertise that the commands are available; neither tool requires a bundled skill by default.

The project also retains its MCP integration framework. CodeGraph and Playwright have optional MCP configurations for the agents that can use them, but MCP is disabled by default. These integrations remain available for development, experiments, and deployments that deliberately choose MCP.

## MCP

MCP is a protocol for exposing capabilities to a model client. Its [server features](https://modelcontextprotocol.io/specification/latest/server/index) include three main primitives:

- [tools](https://modelcontextprotocol.io/specification/latest/server/tools): callable operations
- [resources](https://modelcontextprotocol.io/specification/latest/server/resources): readable context owned by the server
- [prompts](https://modelcontextprotocol.io/specification/latest/server/prompts): reusable prompt templates owned by the server

This project currently consumes MCP tools only. It does not load MCP prompts or resources. An adapter would not decide which server instructions belong in which agent, how instructions should be merged, how provenance should be recorded, or whether server content should be trusted.

For tools, the model chooses from the exposed name, description, and schema. An MCP integration therefore adds tool schemas to the model context and introduces another process, transport, lifecycle, and failure boundary. Those costs may be justified, but they are not free discovery.

MCP is most useful when it exposes something bash cannot accurately provide: an existing application session shared with a human, credentials that must remain outside the sandbox, host resources that cannot be mounted into the workspace, or genuinely interactive operations built around notifications and shared live state.

Remote, long-running, or stateful does not establish that need. A CLI can call a remote API, preserve a session in files, and operate a long-running process. An MCP tool whose main operation accepts an arbitrary command, query, script, or code string deserves particular scrutiny because it may only wrap a capability the agent already has.

Past experiments also show why protocol support is not enough. This project tried StacklokLabs' [OSV MCP](https://github.com/StacklokLabs/osv-mcp) and removed it. In an issue-analyzer probe for [CVE-2024-1724](https://www.cve.org/CVERecord?id=CVE-2024-1724), the server returned valid advisory facts, but they did not help locate or understand the defect in the current checkout. The protocol worked; the capability did not improve the workflow's decision.

Official references:

- [Model Context Protocol documentation](https://modelcontextprotocol.io/)
- [Model Context Protocol specification and documentation repository](https://github.com/modelcontextprotocol/modelcontextprotocol)

## Self-Describing CLIs

Agents already have bash inside the sandbox. A usable CLI can describe itself through its command tree, `--help`, structured output, exit status, stdout, and stderr. Once the runtime tells the agent that a command is installed, the agent can discover the interface as needed instead of receiving every operation as a tool schema up front.

A CLI does not automatically need a skill. Do not copy its command reference into `SKILL.md`. Add a skill only when experiments show that the agent repeatedly lacks knowledge outside the interface, such as:

- when to choose or avoid the tool
- a non-obvious analysis workflow
- how to distinguish an empty result from incomplete analysis
- which results are leads and which are acceptable evidence
- known blind spots and required validation

Until such a gap appears, advertising the command and allowing the agent to inspect `--help` is the smaller and more maintainable integration.

## Why Joern And Playwright Use Only CLIs

Joern contributes code property graphs, structural queries, call relationships, and data-flow analysis. Playwright contributes browser interaction and runtime evidence. The project chooses them for those capabilities, not for any particular integration protocol. The CLI path described here is the target default; the runtime advertisement and corresponding integration tests must land with that migration.

Neither capability requires MCP in this runtime:

- Joern can create and query its analysis projects through local commands and scripts. Its useful state can be stored as files in the sandbox.
- Playwright CLI can own a persistent browser session, reach services started by repository setup, and return browser observations to the agent.
- Both tools run in the same sandbox in which the agent already has bash.
- Neither integration needs host-only credentials, an existing human-operated application session, or a host resource that cannot be made available to the sandbox.

An MCP layer would therefore expose substantially the same capabilities while adding tool schemas and connection lifecycle. It has not demonstrated an additional capability that the default workflow needs. CLI is the default because it is sufficient, not because CLI is universally better than MCP.

Skills remain an optional enhancement for Joern and Playwright, not a prerequisite for using either tool. They may provide additional workflow or interpretation guidance when that guidance proves useful, but the default integration does not depend on them.

## Optional MCP Integrations

Although this project does not recommend MCP as the default tool interface, developers can still add the MCP integrations they need. CodeGraph and Playwright are already integrated with the system and assigned to the agents configured to use them. They are not enabled in normal runs because `AGENT_MCP_ENABLED` defaults to `false`.

A new integration still needs to state what capability or boundary it adds beyond the available CLI or workflow input.

Keep MCP clients and connection helpers in the MCP package. Document the required environment, sandbox, credentials, server availability, trust boundary, and failure policy. Do not attach MCP tools globally.

Testing has distinct layers:

- Contract tests verify loading, schemas, environment gates, failure handling, and agent ownership.
- No-model capability tests verify transport, execution, state continuity, and observable results.
- Gated LLM discovery tests verify that an agent can recognize when and how to use the capability.
- Paired comparisons are warranted only when the claim is that MCP improves decision quality over the simpler alternative.

Do not use an LLM test to establish a deterministic transport or capability fact. Do not load MCP prompts or resources unless the project also defines their provenance, merge order, trust treatment, and prompt-injection handling.
