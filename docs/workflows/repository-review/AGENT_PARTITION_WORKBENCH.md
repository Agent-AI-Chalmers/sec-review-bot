# Agent-Edited Partition Workbench

Language: English | [中文](AGENT_PARTITION_WORKBENCH.zh.md)

## Background

Some repository workflow stages do not judge one object at a time. They organize many items into fewer work units.

These tasks are a poor fit for asking an agent to output one huge final structure at once. It is hard to guarantee no omissions, duplicate consumption, or illegal ownership. A more natural approach is for the system to maintain a workbench, let the agent view and edit it through a small set of tools, and then export the result.

## Problem Definition

### Formal Definition

Abstractly, these stages assign items into typed groups while satisfying coverage, non-overlap, and stage-specific rules.

More strictly:

> Given input items, each with a stable id and stage-defined payload, the goal is to assign these items into typed groups. Each group has `kind`, `reason`, and `item_ids`, and may also have stage extension metadata. The final assignment must satisfy structural constraints such as coverage, non-overlap, legal group kind, required metadata, and final export contract. Each group should also satisfy the semantic boundary of the current workflow, such as same root issue, same patch boundary, same trust failure, or remaining independent analysis value.

`non-overlap` is at-most-once: an item may belong to at most one group at a time. `coverage` is at-least-once: by the end, every item must belong to some group. Together they form exact-once assignment in the final state.

### Constraint Types

There are two constraint layers:

- Structural constraints: valid item ids, non-overlap, coverage, legal group kind, required metadata, final export contract, and similar checks.
- Semantic boundaries: whether items share the same root issue, patch boundary, trust failure, suppress reason, or independent analysis value.

Structural constraints can usually be reliably maintained and checked by the system. Semantic boundaries require semantic judgment and cannot be proven only by static rules.

### No Closure Assumption

Group membership is usually commutative: if A and B belong to the same group, member order does not change group meaning. But semantic relationships are not necessarily transitive: A and B may share a boundary, and B and C may share a boundary, without A and C belonging together. B can be only a bridge item. Pairwise relatedness must not be treated as a connected graph with transitive closure; each group should have a primary boundary shared by all members.

Partition workbench is an agent-edited implementation of this problem. Later sections describe how system state, tools, and completion signals work.

### Related But Different Problems

This resembles several common problem types, but it is not the same as any of them:

- It is not ordinary clustering: the goal is not to discover natural clusters by similarity, but to form stage-defined work units.
- It is not ordinary classification: a group is not a predefined label, but a dynamically created resource with `kind`, `reason`, and membership.
- It is not only deduplication: group kinds such as `keep` / `suppress` express stage semantics, not only duplicate/non-duplicate.

### Related Work Positioning

The mathematical shape is closest to constrained partitioning: the system assigns items to groups while satisfying coverage, non-overlap, legal group kind, and stage rules. Google OR-Tools [assignment with allowed groups](https://developers.google.com/optimization/assignment/assignment_groups) shows the formal direction of assignment under group constraints. However, optimization modeling usually requires enumerable constraints and a clear objective function. Here, "same root issue / patch boundary / trust failure" still requires agent semantic judgment.

If agent judgment were transformed into must-link / cannot-link pairwise constraints, and the system automatically aggregated groups, the problem would be closer to constrained clustering. Constrained clustering literature studies partitions under must-link / cannot-link background knowledge; this [survey](https://link.springer.com/article/10.1007/s10462-024-11103-8) discusses hard constraints, soft constraints, noisy constraints, and constraint types. That direction shows pairwise constraints are a mature toolset, but it also brings pair explosion, noise, conflicts, and constraint selection problems. It is therefore better suited as an internal hint than as the current main flow.

Correlation clustering is another adjacent direction: it takes positive / negative pairwise relationships as input and searches for a partition that satisfies them as well as possible. Related work notes that constrained correlation clustering is often computationally hard; for example, this [weighted partial MaxSAT formulation](https://www.sciencedirect.com/science/article/pii/S0004370215001022) treats it as a constraint-solving problem. This helps explain why "make everything pairwise" is not a free engineering simplification.

LLM-guided clustering shows that LLMs can produce semantic constraints. For example, [Large Language Models Enable Few-Shot Clustering](https://aclanthology.org/2024.tacl-1.18.pdf) uses an LLM as a pairwise constraint source and then performs clustering. The shared idea is using an LLM for semantic grouping judgment. The difference is that this design is not "LLM generates constraints, then clustering runs"; it is "agent directly edits a typed workbench", and groups also carry stage metadata such as `kind`, `reason`, summary, and evidence.

The industrial analogy is alert grouping / alert correlation: organize many fine-grained signals into fewer actionable work units, reduce noise, and match triage / response workflows. Jira Service Management [alert grouping](https://support.atlassian.com/jira-service-management-cloud/docs/configure-alert-grouping/), PagerDuty [Alert Grouping](https://support.pagerduty.com/main/docs/alert-grouping), and ServiceNow [alert correlation rules](https://www.servicenow.com/docs/r/zurich/it-operations-management/event-management/t_EMConfigureAnEventCorrelationRule.html) all reflect this need. The point is not to discover natural clusters, but to organize related signals into processable work units.

## Why This Design

These partition tasks involve many semantic judgments that are hard to fully encode as static rules or optimization objectives. Whether two items should be grouped may depend on shared root issue, patch boundary, trust failure, review unit, or whether a weak supporting clue has independent value. These judgments are suitable for an agent.

The most direct agent approach is to ask the agent to output the complete item -> group mapping or final JSON in one shot. But that gives the agent too much mechanical responsibility:

- remember every item
- guarantee stage-required coverage
- maintain non-overlap between groups
- avoid missing fields or ids while producing a huge structure
- rewrite the whole result after discovering a local mistake
- generate extra natural-language summary not constrained by the contract

Partition workbench makes a tradeoff: the agent keeps semantic judgment, while mechanical responsibility returns to the system. The agent only creates, moves, merges, splits, and explains groups. The system owns state consistency, structural constraint checking, and final export.

This resembles how humans handle complex collection tasks: not by writing the final table in one shot, but by continuously organizing, moving, and correcting cards on a visible workbench until the state passes checks.

## Workbench Model

The system maintains two first-class state types:

- `items`: read-only input items. Each item has a stable id and stage-defined payload.
- `groups`: work units created and edited by the agent.

Item-to-group ownership is derived by the system from `groups[*].item_ids`.

The underlying workbench operations are independent of payload semantics. Payload is read-only judgment material supplied to the agent by the stage. The workbench only maintains state by item id and group membership, checks structural constraints, and exports stage results at the end.

During editing, the system maintains non-overlap:

- an item may belong to at most one group at a time
- when an item is placed into a new group, the system updates its single ownership
- when a group is deleted, its items become uncovered

At completion, the system checks final constraints:

- every item must be covered by some group
- groups must satisfy the current workflow schema and completion conditions, such as legal `kind`, required metadata, and allowed final ownership shape

For delivery planning, all items must eventually enter the same `delivery` group kind. For triage, items may enter `keep` groups or `suppress` groups, with exact rules defined by the stage.

## Tool Shape

Tool semantics stay small and generic. The core is CRUD over group resources.

Atomic write tools:

- `create_group`: create a group, optionally with initial `item_ids`
- `update_group`: update group metadata or `item_ids`
- `delete_group`: delete a group; items in the deleted group become uncovered

Batch write tools:

- `create_groups`
- `update_groups`
- `delete_groups`

1. Batch tools are not a new grouping method. They are isomorphic batch forms of atomic group CRUD. They follow the same membership and constraints rules as `create_group` / `update_group` / `delete_group`, and exist to reduce tool call count and intermediate-state noise.
2. Batch tools should not be understood as final submit tools. If the agent can form a full draft directly from input payload, it is reasonable to use `create_groups` to create that full draft at once, then use atomic or batch tools to correct small mistakes. If a full rewrite of an existing draft is needed, use `delete_groups` to clear relevant groups first, then `create_groups` to create the new draft.

Batch write tools should check command-level structural conflicts as much as possible before modifying the workbench. In particular, tools like `create_groups` that create resources should check `group_id` conflicts within the batch and against existing state before writing. If a batch call fails, it should not leave partially created groups or partially recorded edit events.

Read tool:

- `read_groups`: read the current group list, including group metadata and item_ids membership.

Check tool:

- `check_constraints`: read current hard constraint check results, such as coverage or missing required metadata.

Tools not exposed, based on experience, mainly to reduce unnecessary agent tool calls:

- Do not expose `read_group`: the agent should inspect current draft structure through `read_groups`. Expanding item payload by one group at a time easily repeats evidence already present in the prompt and encourages repeated reads.
- Do not expose `read_item` / `read_items`: item payload is usually provided directly in the user prompt. The workbench core only operates by item id and group membership; the agent does not need to read item payload one by one.

### Write Tool Return Values

`create_group` / `create_groups` / `update_group` / `update_groups` / `delete_group` / `delete_groups` are write tools and should not return the full group list as a side effect.

Their return value should be a compact mutation result: what changed in this call and whether current hard constraints are still satisfied. The full group list should only be read through explicit `read_groups`.

Avoiding full groups in every write response is important. Otherwise, a small edit repeatedly injects all group metadata back into context, amplifying tokens and making it easier for the agent to misread state inside huge tool output.

### Completion Signal

The agent does not export final results through an ordinary tool. It returns a very thin structured completion response, for example `{"done": true}`.

The system runs the structural constraints checker at the completion signal. The completion signal is valid only if structural constraints such as coverage, non-overlap, legal `kind`, required metadata, and final export contract pass. Then the system exports final results from workbench state.

If structural constraints fail, the system rejects the completion signal and the agent should keep editing the workbench instead of ending. Whether semantic boundaries are correct remains the agent's judgment and is not automatically proven by the constraints checker.

## Agent Working Style

The agent does not directly output the final plan. It should work like a person arranging cards on a workbench:

1. First see the static background information in the input, usually all item payloads.
2. Inspect unprocessed items and current workbench state together with static background signals.
3. Create group(s) and place initial item(s).
4. Adjust metadata or item ownership by updating groups, or delete groups that are no longer needed.
5. Inspect current state and constraints.
6. Return the completion response once constraints pass.

The final result is exported by the system from workbench state, not handwritten by the agent as full JSON or natural-language summary.

This working style should be reentrant: the agent may face an empty workbench or groups already organized by a previous round. Each run reads current state first. If groups already exist, most runs should treat them as a draft and make local corrections rather than rebuilding from scratch.

### Refinement

Reentrancy makes a second refinement round natural: the first agent run can create a full draft from an empty workbench; the second agent run can inherit the same workbench and treat existing groups as a draft for quality correction.

Refinement is not introduced for coverage. Coverage is the system constraints checker's job. The real issue is that in the first pass, the agent often reads the full input and then confidently creates a draft with `create_groups` in one call. That draft usually satisfies constraints, but may still contain over-merge, missed merge, weak reason, or keep/suppress boundary errors.

A natural idea is to ask the same agent run to self-check before finishing. But "self-check" is easily executed as bookkeeping: recounting items, restating groups, writing long justifications for existing groups, or proving coverage. It increases tokens and context noise without reliably producing better edits. Refinement is valuable because the first judgment is externalized into workbench state, and the next round treats it as a draft while looking only for concrete editable group boundary problems. If there is no concrete edit, it ends.

Effective refinement should:

- first use `read_groups` to read the current draft structure
- use item payloads in the prompt to inspect risky group boundaries
- focus on over-merge, missed merge, and weak reason
- make targeted group edits through `update_group(s)` / `create_group(s)` / `delete_group(s)`
- finally read constraints and finish

Do not encourage the agent to manually count item_ids, list every group, or restate coverage after constraints are OK. That bookkeeping pollutes later context, and the system already checks it reliably.

### Single And Batch

Common execution modes on this workbench model:

- `single + optional refinement`: one agent pass processes the full item inventory; if quality correction is needed, run refinement on the same workbench.
- `batch + refinement`: multiple batch drafts process item subsets in parallel, then merge drafts into one global workbench for refinement.

Batch is a wall-time tradeoff, not a smarter default planning mode.

It was initially introduced not because medium-sized input necessarily failed to fit in context, but because **slower models took too long to process many items at once**. Batch can split the draft stage in parallel, reducing input size and wait time per draft invoke.

Batch is faster, **especially on slow models**. But it has real costs:

- batch drafts do not see cross-batch merge opportunities, i.e. they lack global view;
- global refinement is still required for global audit.

Therefore, batch is better treated as a latency workaround, not the default shape. Especially when a fast model's single run is already fast enough, batch wall-time advantage shrinks and its downsides become more visible: it introduces batch-boundary loss and still requires global refinement to recover global judgment.

Do not describe this batch design as a solution for huge input too early. If refinement still needs to read all item payloads, batch only reduces draft invoke input size and reasoning time. It does not remove the problem that final global audit faces all items.

### Batch Refinement Context

When a stage uses batch draft followed by global refinement, the system can provide a lightweight draft origin list in the refinement user prompt to help the agent prioritize cross-local-context boundary checks.

Recommended shape lists group ids by origin scope:

```markdown
Use this section only to prioritize refinement attention. Groups from different draft scopes may not have been compared in the same pass.

- `draft batch 0001`: `group-1`, `group-2`, `group-3`
- `draft batch 0002`: `group-4`, `group-5`
```

This is not group metadata and not a new tool view. Groups themselves still express current workbench state. Draft origins are only read-only context for the refinement pass, explaining which groups were produced in the same local draft scope.

The goal is not to make the agent trust in-batch results, but to adjust attention priority:

- Prioritize duplicate, missed-merge, boundary-misalignment, or keep/suppress inconsistency across different draft scopes.
- Groups from the same draft scope were already seen together in one local context, so they do not need equal review cost unless the boundary is obviously weak.
- If refinement moves, merges, or deletes groups, draft origins do not need to be synchronized as final state; final results are still exported from current groups.

Keep this design lightweight. Do not copy item payload, summary, evidence, or reason into draft origins; those are already available through `read_groups` and stage input. Draft origins answer only one question: which groups came from the same local draft context.

## How Common Grouping Intents Map To Tools

These grouping intents do not need separate tools exposed to the agent. The table only explains how they map onto basic tools.

Normal grouping and adjustment:

| Scenario | Method | Tool call |
| --- | --- | --- |
| One item should remain alone | Create a normal group with this item as initial member. | create_group(item_ids=[item_id]) |
| Multiple items should be handled together | Create a normal group with these items as initial members. | create_group(item_ids=[...]) |
| Two existing groups are later found to be one group | Update the target group's item_ids to include both sides, then delete the emptied group. | update_group(item_ids=[...]) -> delete_group |
| A group contains items that should not be together | Create a new group to take some items, then update original group item_ids. | create_group(item_ids=[...]) -> update_group(item_ids=[...]) |
| A group's members should be rewritten wholesale | Update the group with new item_ids. | update_group(item_ids=[...]) |
| An item is in the wrong group | Update the correct group's item_ids to include this item; the system automatically removes old ownership. | update_group(item_ids=[...]) |
| An item should temporarily belong to no group | Update the current group's item_ids to remove this item. | update_group(item_ids=[...]) |
| A group's explanation is inaccurate | Update group reason. | update_group(reason=...) |

Stages that allow discarding items need `suppress` groups:

| Scenario | Method | Tool call |
| --- | --- | --- |
| One item should be suppressed | Create a `suppress` group with this item as initial member. | create_group(kind=suppress, item_ids=[item_id]) |
| Multiple items are suppressed for the same reason | Create a `suppress` group with these items as initial members and a clear reason. | create_group(kind=suppress, item_ids=[...]) |
| A suppressed item should be restored | Update a normal group's item_ids to take it, or delete the `suppress` group so it becomes unprocessed. | update_group(item_ids=[...]) or delete_group |

Prompts may keep using these grouping intents to help the agent understand the task. Tools should still expose group reading, constraints checking, single group CRUD, and batch group CRUD. Completion is expressed through structured completion response.

## Appendix

### Delivery Planning Experiment Notes

The following records a comparison experiment for bookshop repository delivery planning on a 53-item input. The goal was not to rank models permanently, but to understand single / batch and flash / pro tradeoffs in the current workflow design.

Experiment setup:

- `single-flash`: single draft + refinement, using flash model.
- `single-pro`: single draft + refinement, using pro model.
- `batch-flash`: two parallel batch drafts + global refinement, using flash model.
- `batch-pro`: two parallel batch drafts + global refinement, using pro model.

| Experiment | Passes | Wall time | Total tokens | AI messages | Deliveries | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `batch-flash` | 3 | ~2m58s | 285k | 13 | 27 | Fastest; controlled cost; minor over-merge caused by batch boundary. |
| `batch-pro` | 3 | ~9m00s | 268k | 12 | 26 | Token no longer exploded, but quality was worse, leaving multiple bridge / transitive merges. |
| `single-flash` | 2 | ~3m59s | 449k | 12 | 28 | Good quality; refinement read two patches, increasing token use. |
| `single-pro` | 2 | ~15m06s | 272k | 9 | 29 | Best and most conservative quality, but highest wall time. |

Notes:

- Batch wall time is end-to-end: two drafts run in parallel, taking the slower draft time, plus global refinement.
- `single-flash` token count was high mainly because refinement inspected patches.
- `batch-pro` problem was not token count but quality: it was more likely to create transitive merges through bridge cases.

Main quality observations:

- `single-pro` was the quality ceiling in this run; `single-flash` was close and faster.
- `batch-flash` was the most promising batch shape: fast and cheap, but needs refinement to better correct batch-boundary loss.
- `batch-pro` is not suitable as default; it corrected one smaller cookie over-merge but left more serious checkout / JWT / addReview bridge merges.
- Delivery count alone is not a quality metric. Fewer deliveries can be effective merging or harmful over-merge.

Short-term strategy from this run:

- Use `single` as the quality baseline.
- Do not enable batch by default when a faster model's single run is already fast enough.
- Use batch as a latency workaround only when single wall time or single-pass burden is unacceptable.
- `batch draft + full global refinement` cannot claim to solve huge input, because refinement still needs global evidence.

### Triage Experiment Notes

The following records an intermediate comparison experiment for bookshop repository triage on a 95-candidate input. It happened before later prompt tightening, so it is better treated as workflow observation than final quality conclusion.

Experiment setup:

- `single-flash`: single draft + refinement, using flash model.
- `single-pro`: single draft, using pro model.
- `batch-flash`: multiple parallel batch drafts + global refinement, using flash model.
- `batch-pro`: multiple parallel batch drafts + global refinement, using pro model.

| Experiment | Passes | Wall time | Total tokens | AI messages | Keep cases | Suppressed | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `batch-flash` | 5 | ~2m36s | 434k | 20 | 62 | 27 | Fastest; controlled cost, but refinement still had cost. |
| `batch-pro` | 5 | ~12m03s | 476k | 22 | 45 | 25 | Slower than flash, more conservative output, still needed cross-batch boundary checks. |
| `single-flash` | 2 | ~3m40s | 492k | 11 | 73 | 22 | Acceptable speed, but tends to keep more independent cases. |
| `single-pro` | 1 | ~12m08s | 333k | 7 | 33 | 42 | Most aggressive, suppressing and merging more candidates; needs human confirmation for overreach. |

Notes:

- Batch wall time is end-to-end: batch drafts run in parallel, followed by global refinement.
- Triage case count is harder to interpret than delivery planning count: fewer cases may be correct dedup / suppress, or over-suppress / over-merge; more cases may be conservative, or missed merge.
- Batch's main purpose remains reducing single-round input size and wall time. One side effect in triage is reducing the chance that a single pass over many candidates over-merges by broad theme; the cost is more cross-batch missed merge or mistaken split, so global refinement remains necessary.

Main quality observations:

- `single-flash` tends to keep more cases and is useful as a conservative baseline, but may retain weak companion, schema/client-only, or generalized hardening candidates.
- `single-pro` tends toward stronger compression and can reduce noise, but needs more caution for over-suppress and cross-boundary merge.
- `batch-flash` balances speed and quality; it suggests triage batch is not only a latency workaround, but also changes grouping tendency when the model faces large input.
- `batch-pro` did not clearly become the quality ceiling; a stronger model is not necessarily better for this grouping task.

Short-term strategy from this run:

- Triage should clearly explain "same root issue / direct call chain / same sink or trust failure" while avoiding unfamiliar concepts and excessive rule enumeration.
- For triage, batch can reduce single-round input pressure; reducing broad-theme over-merge is only a side effect and cannot replace refinement.
- Do not judge quality only by keep case count; inspect whether suppressed candidates are reasonable, same root issues are merged, and independent sinks are incorrectly merged.
- In the current shape, `single-flash` and `batch-flash` are both worth keeping as experiment entries; `pro` is better as a comparison point and should not be assumed as default.
