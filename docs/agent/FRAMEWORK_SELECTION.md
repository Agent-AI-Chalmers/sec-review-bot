# Agent Framework Selection

Language: English | [中文](FRAMEWORK_SELECTION.zh.md)

This note records why the runner currently builds stage agents with LangChain `create_agent` plus project middleware, instead of directly using the high-level `deepagents.create_deep_agent` entry point or dropping all the way down to LangGraph.

## Current Position

The project uses `deepagents` as a toolkit, not as the top-level application framework.

It reuses useful lower-level pieces:

- filesystem middleware and backend protocol shapes
- sandbox protocol ideas
- skills middleware and the `<source>/<skill>/SKILL.md` discovery convention
- result types used by file, search, edit, upload, and execute operations

But this project still owns how the security-review workflow runs.

## Why Not `create_deep_agent`

Early demo work considered using `deepagents.create_deep_agent` directly. It is useful because it quickly provides a complete coding-agent shape. As the project moved toward a security-review system, the important question became less "can the agent read files and call tools" and more "which stage owns which responsibility, context, tools, and structured result."

From that angle, `create_deep_agent` is a high-level harness with useful defaults. It assembles a set of middleware and runtime conventions on top of the underlying agent loop. This project needs those pieces to be recombined per stage rather than accepted as one general-purpose agent shape.

The current design therefore reuses useful `deepagents` middleware and backend protocols, while building each stage agent explicitly with LangChain `create_agent`. This is not a rejection of `deepagents`; it avoids letting a general-purpose harness decide the responsibilities of the security-review workflow.

In hindsight, this choice has held up. The memory mechanism is one example: it is not as simple as using the default memory middleware. It includes post-run observation extraction, offline maintenance of fragmented lessons, and a progressive-disclosure layout closer to Claude Code memory, so agents first see a bounded startup index and then read relevant topics on demand.

## Why Not Raw LangGraph

LangGraph is the lower-level graph runtime under this style of agent system. It would make sense if the workflow shape became stable enough that the project wanted to own every node, edge, retry, state field, and reducer directly.

For the current project, that would be premature. The main engineering work is still in the security-review semantics and runtime boundaries around each stage. LangChain `create_agent` keeps the agent loop and middleware integration compact while still allowing project-specific control where it matters.

## Why Temporal For Workflow Execution

The execution system uses Temporal.

![Sliding-window repository case workflow timeline](../../assets/screenshots/repository-case-sliding-window-timeline.png)

> *Timeline screenshot is for scheduling-shape reference only; workflow and activity labels may come from an older run and are not the current API names.*

This timeline shows a repository review where the runner workflow prepares repository case workflows and Temporal tracks sliding-window workflow / activity execution over time.

Reasons for using Temporal:

- Runner runs are long-running flows, so queued, running, completed, and failed states should be owned by the execution system.
- The Temporal task queue is the only queue for runner execution.
- Temporal workflow history is the source of truth for later durable step splitting; handwritten checkpoint files are no longer used.
- Internal workflow / activity orchestration needs durable scheduling, retry, timeout, and failure propagation across prepare / analysis / mitigation / verification / delivery stages.

The [Temporal website](https://temporal.io/) describes another reasonable Temporal + agent design: put the agent loop inside the workflow definition, persist the message history in workflow state, and call the LLM and tools through activities. That design makes the agent loop itself durable.

This project does not take that path. Temporal is durable workflow orchestration, not the agent reasoning layer. The project uses Temporal for stages, activities, retries, outputs, and failure propagation instead of putting a free-form agent loop directly inside the workflow definition. The core unit is a security review workflow with clear stages, input contracts, and structured output; Temporal manages reliability and scheduling, while agents handle judgment and generation.

## Future Direction

If a stage becomes stable enough that its agent loop is mostly fixed, it can be moved closer to raw LangGraph later. That would make sense for code whose main problem is precise graph state, retry, and node ownership.

That is not the current bottleneck. Similar project-specific responsibilities are still easier to evolve in our own runtime than inside a larger harness.
