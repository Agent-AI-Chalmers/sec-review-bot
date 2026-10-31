# Stage, Agent, and Resource Lifetimes

Language: English | [中文](STAGE_AGENT_OWNERSHIP.zh.md)

This project uses language models to inspect code, propose fixes, and pass results to later steps. A task needs more than a model call: code files must be prepared, tools supplied, results saved, and temporary environments cleaned up. This document explains why that work is divided between stages and agents, and how to decide who owns each part.

The example below uses a code fix to introduce the concepts. It illustrates responsibilities rather than requiring every stage to follow the same steps.

## Follow a Code Fix from Start to Finish

Suppose an earlier step supplies a problem description and the code to fix. The next work is to:

1. Create a temporary directory and put the code in it.
2. Give the model the problem description and tools for reading and editing code.
3. Let the model inspect the code, use tools to edit files, and return an explanation.
4. Generate a patch from the edited files and save it with the explanation for later verification or delivery.
5. Close connections and clean up the temporary environment when it is no longer needed.

In this example, a **stage is the program responsible for completing the whole repair operation**. It receives upstream inputs, arranges execution, and produces results that later steps can use. Analysis, repair, and verification can each have their own stage.

An **agent is the part that performs a task through a model and tools**. It supplies prompts and tools, lets the model continue working with tool results, and obtains a final result.

When the model finishes its edits and returns an explanation, the agent execution can end, **but the repair stage is not finished**: it still needs to extract and save the patch. That is the main distinction between a stage and an agent.

## Names Used in the Code

These names also appear in the surrounding code. The last column follows one example throughout: fixing a missing input check in `app.py`. File names and paths in the example are illustrative.

| Name | Meaning in this document | Example within the same repair |
| --- | --- | --- |
| Agent call entrypoint | A function callers use to run an agent and obtain its result. It can prepare tools and invoke the model without requiring an agent class. | The stage calls the repair entrypoint with the problem description and prepared backend, then awaits the result. |
| Graph | An executable flow in which LangGraph organizes model calls, tool execution, and related steps. A `CompiledStateGraph` is a compiled, executable graph object; creating it does not mean the agent has run. | The repair entrypoint builds a graph that arranges model inspection of `app.py`, calls to editing tools, and the final explanation. |
| Backend | The interface tools use to access files or execute commands. It determines which workspace and execution environment tools can use; it does not mean a backend service in this context. | File tools in the graph access `app.py` in the temporary workspace through the backend. |
| Middleware | Code that adds processing around model or tool execution, such as adding context or checking results. | During execution, middleware adds project instructions to the model context, such as requiring a test for the input check. |
| Memory view | A view of experience-memory files made available to an execution so the agent can consult prior lessons. It does not mean process memory used by the model. | The model uses file tools to read lessons from the memory view about input checks in this project. |
| Artifact | An output needed by later steps, such as a patch file, review result, or execution record. | After the agent returns, the stage generates `workspace.patch` from the changes to `app.py` and saves it with the explanation. |

These names describe different things: a stage expresses a business step, an agent expresses how a model performs a task, and a graph is one technical way to execute an agent. They do not require a matching class or object for each concept.

## Divide Responsibilities by the Work to Be Done, Rather Than Resource Management

A stage prepares business inputs, arranges agent execution, and handles business results. An agent handles prompts, tools, model execution, and output formats. The stage need not understand how each internal tool connects, and the agent need not know which later stage will receive the patch.

A resource is something that must remain available while in use and needs cleanup afterward, such as a temporary directory, connection, or process. Its lifetime runs from creation or acquisition to release. Code that owns a resource is responsible for arranging that lifetime and cleaning up on failure. Other code can borrow it without being responsible for closing it.

Resource management follows business responsibilities. Defining a stage as a resource preparation layer and putting everything that needs cleanup there obscures that boundary. Workspaces and MCP sessions illustrate why different resources belong in different places.

## Why the Stage Usually Owns the Workspace

For patch generation, workspace use might look like this:

```text
Create workspace → restore input snapshot → agent edits files → extract patch and save artifacts → delete workspace
```

After the agent returns, the stage still needs to read files. The workspace should cover that whole operation, making the stage a suitable owner. The agent borrows a backend that provides workspace access; returning from the call does not authorize it to destroy the caller's backend.

Judge backends and memory views by their actual use as well. Receiving a resource from the stage does not give the agent control over when it closes. A resource used within one agent call need not move to the stage just to make the code look uniform.

## Why the Agent Call Can Own MCP Sessions

MCP (Model Context Protocol) is a protocol for communication between programs and tool services. For example, an agent can use a code-query tool provided by another process through MCP. The model sees a callable tool; the program establishes a connection, sends requests, and reads results behind it.

A session is the context that keeps the connection and communication state available. Sessions, connections, and processes that may start with those connections have lifetimes to manage. Loaded tools may be bound to a session. Closing that session early means keeping the tool object alone cannot ensure it remains callable.

The agent knows which MCP capabilities it needs. For sessions used within one call, its call entrypoint is a suitable place to open sessions, load tools, build and execute the graph, and close sessions on exit. The underlying MCP helper implements connection and cleanup mechanics. Normal returns, exceptions, and cancellation all need consideration.

The stage supplies execution conditions such as a backend and receives the result, without handling MCP transport configuration or sessions. This division lets the stage own the longer business operation while the agent owns its tool use.

<!-- doc-default: sec_review_agents.mcp.client.managed_mcp_tools_async; source=agents/src/sec_review_agents/mcp/client.py -->
[managed_mcp_tools_async](../../agents/src/sec_review_agents/mcp/client.py) loads and yields session-bound tools inside its context and cleans up sessions on exit. A graph using those tools should execute inside that context; returning the graph alone does not transfer the session lifetime to the caller.

When a session depends on a borrowed backend, end the session before releasing that backend. If a connection later needs to span multiple agent calls, choose its owner based on that actual usage scope. There is no need to design a shared manager in advance.
