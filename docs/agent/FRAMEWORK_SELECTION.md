# Agent Framework Selection

Language: English | [中文](FRAMEWORK_SELECTION.zh.md)

This note records why the agent framework currently builds stage agents with LangChain `create_agent` plus project middleware, instead of directly using the high-level `deepagents.create_deep_agent` entry point or dropping all the way down to LangGraph.

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

In hindsight, this choice has held up. The memory mechanism is one example: it is not as simple as using the default memory middleware. It includes post-run observation extraction, offline maintenance of fragmented lessons, and a progressive-disclosure layout closer to Claude Code memory, so agents first see the startup index and then read relevant topics on demand.

## Why Not Raw LangGraph

LangGraph is the lower-level graph runtime under this style of agent system, and it also offers durable execution and thread state through a checkpointer. The project uses the first part and does not use the second: the graph shape stays under `create_agent`, and durability stays at the Temporal stage boundary. Those are two separate decisions.

### The agent loop stays with `create_agent`

It would make sense to own every node, edge, retry, state field, and reducer directly if the workflow shape were stable enough. For the current project, that would be premature. The main engineering work is still in the security-review semantics and runtime boundaries around each stage. LangChain `create_agent` keeps the agent loop and middleware integration compact while still allowing project-specific control where it matters.

### Checkpointed graph state is not durable execution here

The graphs built in `runtime/agent_runtime_graph.py` are constructed without a checkpointer and are invoked once per stage, so a run has no thread state to resume from. Enabling one would not give us finer-grained recovery, and the reason is a property of sandboxed agents in general rather than of this project:

- **A checkpoint restores graph state, not the environment the agent worked in.** A stage's workspace is a temporary directory restored from the input snapshot, and its command sandbox is a Docker container created for that invocation and removed when the stage ends. After a process restart both are gone, so the checkpoint would resume at a `next` node whose files, running processes, and tool sessions no longer exist. Restoring the graph without restoring the environment moves the failure later rather than absorbing it.
- **Recovery granularity has to account for side effects.** A replayed node writes artifacts and runs commands against a filesystem that is not checkpointed. Artifacts are local stage files with per-attempt cleanup, and trajectories are named by stage attempt, so a replayed node either duplicates work or leaves a half-written stage behind.
- **The stage is already the durable unit.** Inside one Temporal activity, the container, MCP sessions, bootstrap result, and artifact directory form a single lifecycle that cannot be split at no cost. Recovering within it needs the environment itself to be reconstructible, which is a sandbox design problem, not a graph-state problem.

Putting the agent loop inside the workflow definition, as [Temporal's AI cookbook](https://docs.temporal.io/ai-cookbook) describes, runs into the same split: the LLM and tool calls become durable activities, but the container they mutate is still outside any durable state.

These are deliberate boundaries. Temporal owns durability at the stage boundary and treats a stage environment as the property of the activity that created it; LangGraph owns the agent loop inside that boundary and is used without a checkpointer.

### What the field reports

The split above is not unique to this project. The following work names it directly.

- [Safe to Resume? Breaking Execution Continuity of Agent Execution via Rollback](https://arxiv.org/abs/2608.29381) (arXiv 2608.29381) studies checkpoint and rollback as a security surface rather than only a performance one. Its central claim is that correct rollback does not imply secure recovery: a faithfully restored checkpoint can resume an execution whose internal state, assumptions, and external effects never coexisted in any valid history. It lists stale external dependencies and unrecorded external effects among the failure modes, demonstrates them against several frameworks including LangGraph, and attributes them to a common gap between the state a checkpoint restores and the dependencies a safe continuation needs. That is the same gap this document describes at the stage boundary.
- [DART: Semantic Recoverability for Structured Tool Agents](https://arxiv.org/abs/2605.23311) (arXiv 2605.23311) states the recovery dilemma directly: replaying the whole task is safe but wasteful, while restoring from a local checkpoint is efficient but can leave committed downstream work tied to an upstream history that no longer exists. It formalizes *semantic recoverability*, certifies which boundaries of a failed instance are recoverable, and admits a restore point only when it preserves committed downstream work. Its evaluation includes external validation on a LangGraph substrate, and it reports that controller legality does not imply semantic validity.
- [DeltaBox: Scaling Stateful AI Agents with Millisecond-Level Sandbox Checkpoint/Rollback](https://arxiv.org/abs/2605.22781) (arXiv 2605.22781) attacks the problem from the sandbox side instead of the controller side. It assumes agents need checkpoint and rollback of the complete sandbox state, including files and process state, and that duplicating that state wholesale is too slow for search and fan-out. It introduces OS-level change-based checkpoint/rollback (layered filesystem state plus incremental process dumps) and reports millisecond-level latency. This is the class of mechanism that would make in-stage recovery meaningful here, because it restores the environment a resumed node needs rather than only the graph that resumes into it.

## Why Temporal For Workflow Execution

The execution system uses Temporal.

![Sliding-window repository case workflow timeline](../../assets/screenshots/repository-case-sliding-window-timeline.png)

> *Timeline screenshot is for scheduling-shape reference only; workflow and activity labels may come from an older run and are not the current API names.*

This timeline shows a repository review where the review workflow prepares repository case workflows and Temporal tracks sliding-window workflow / activity execution over time.

Reasons for using Temporal:

- Review runs are long-running flows, so queued, running, completed, and failed states should be owned by the execution system.
- The Temporal task queue is the only queue for review execution.
- Temporal workflow history is the source of truth for later durable step splitting; handwritten checkpoint files are no longer used.
- Internal workflow / activity orchestration needs durable scheduling, retry, timeout, and failure propagation across prepare / analysis / mitigation / verification / delivery stages.

Temporal also documents a reasonable Temporal + agent design: put the agent loop inside the workflow definition, persist the message history in workflow state, and call the LLM and tools through activities. That design makes the agent loop itself durable, but it does not make the stage environment durable, which is why it would not change the conclusion above.

This project does not take that path. Temporal is durable workflow orchestration, not the agent reasoning layer. The project uses Temporal for stages, activities, retries, outputs, and failure propagation instead of putting a free-form agent loop directly inside the workflow definition. The core unit is a security review workflow with clear stages, input contracts, and structured output; Temporal manages reliability and scheduling, while agents handle judgment and generation.

## Future Direction

If a stage becomes stable enough that its agent loop is mostly fixed, it can be moved closer to raw LangGraph later. That would make sense for code whose main problem is precise graph state, retry, and node ownership.

That is not the current bottleneck. Similar project-specific responsibilities are still easier to evolve in our own runtime than inside a larger harness.

Finer recovery within a stage has to start from the sandbox, not from a checkpointer. The shape worth evaluating is a stage environment keyed by a stable per-stage identity, restored from the snapshot and artifact directory, so that a resumed node finds the sandbox it expects. Until that exists, a checkpointer would only add a second, incompatible notion of where a run is. The [DART](https://arxiv.org/abs/2605.23311) admissibility check is the criterion that such a restore would have to satisfy: a resumed stage must not continue work whose upstream inputs no longer exist.
