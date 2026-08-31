# Refinement Pass

This pass refines an existing delivery-plan draft. Treat existing groups as a draft from another planner, not as ground truth. Exact coverage is enforced by the system, so your value here is plan quality refinement.

# Refinement Flow

Follow this flow for the whole pass:

1. Call `read_groups` once at the start.
2. Inspect the current group membership and reasons. Use the provided item payloads only for groups whose delivery boundary, membership, or reason you need to judge.
3. Apply all concrete targeted group edits needed for moves, splits, merges, or reason fixes. Prefer targeted edits to existing groups; do not rebuild the whole draft unless it is broadly unusable.
4. When you have either finished the needed edits or decided that no concrete edit is needed, call `check_constraints` once.
5. If constraints are ok, immediately return the structured completion response. Do not call more tools, recount membership, restate edits, or summarize.
6. If constraints are not ok, fix the reported constraint issue, then call `check_constraints` again.

Call `read_groups` a second time only before `check_constraints`, and only when an edit changed membership and the mutation acknowledgement is insufficient to decide the next edit. Never call `read_groups` after `check_constraints` returns ok.

Spend judgment on concrete boundary problems in the current draft. Avoid enumerating all groups or counting memberships unless that directly drives an edit.

Prioritize cross-scope comparisons, when draft origins are provided, before rechecking groups from the same draft scope.

# Refinement Checks

Look for concrete delivery-plan quality problems. Use the smallest edit that fixes the problem, and leave the draft unchanged when no concrete problem is visible.

Move misplaced items:

- Move an item when it clearly belongs with a different group that shares its primary patch-surface boundary.
- Do not move an item merely because it shares a file, CWE, endpoint family, broad theme, or weak contextual relationship with another group.
- If a bridge item touches multiple boundaries, assign it to the dominant boundary shown by its changed files and mitigation overview.

Split groups that are too broad:

- Large combined groups need especially concrete boundaries. Split any member whose only relationship is same file, same CWE, same endpoint family, or broad theme.
- Split transitive-chain groups: if A relates to B and B relates to C, but A and C do not share the same primary patch-surface boundary, keep the sides separate and assign the bridge case to its dominant boundary.
- Treat chain-shaped reasons as suspect. If a reason explains the group through pairwise links, bridge cases, or multiple unrelated boundaries, replace it with a primary-boundary reason or split the group.
- Cross-cutting helper groups are valid only when the cases introduce competing helpers, replace the same callsites, or touch the same abstraction boundary.
- Same route file is not enough if the fixes sit in different functions, independent validations, independent authorization checks, or unrelated sinks.
- Same handler flow is not enough when the members change independent operations. Keep separate operations separate unless one operation directly consumes the value, state, or control flow produced by another in the same request path.
- Do not split merely to make groups smaller; split only when membership crosses a real delivery boundary.

Merge groups that share a concrete patch boundary:

- Singleton groups should merge only when they are alternative fixes, subsuming fixes, or execution-coupled changes at the same patch-surface boundary.
- Non-singleton groups may merge when both groups describe the same primary patch-surface boundary and would be reviewed as one delivery.
- If two singleton groups merely share a file but the mechanisms are independent and can be reviewed separately, keep them single.
- In batched mode, pay special attention to duplicate delivery groups created in different draft batches.
- If merge certainty is not high, keep groups separate.

Narrow inaccurate reasons:

- A combined group reason should name the shared primary patch-surface boundary, not a chain of pairwise overlaps.
- If a reason relies on same file, same CWE, same endpoint family, broad theme, bridge cases, or multiple unrelated boundaries, narrow the reason or split the group.
- Do not rewrite reasons for style only.

Use targeted group edits when possible:

- Prefer `update_group`/`create_group`/`delete_group` for small refinements.
- Use `update_groups`/`create_groups`/`delete_groups` when the same refinement applies to multiple groups.
- For a full rewrite, call `delete_groups` for the existing groups and then `create_groups` for the new complete draft.
