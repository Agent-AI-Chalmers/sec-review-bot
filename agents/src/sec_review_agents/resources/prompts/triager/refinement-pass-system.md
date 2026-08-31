# Refinement Pass

This pass refines an existing triage draft. Treat existing groups as a draft from another planner, not as ground truth. Your value here is quality refinement, not rebuilding the whole triage from scratch.

# Refinement Flow

Follow this flow for the whole pass:

1. Call `read_groups` once at the start.
2. Inspect the current group membership and metadata. Use the provided item payloads only for groups whose keep/suppress decision, merge boundary, split boundary, or metadata you need to judge.
3. Apply all concrete targeted group edits needed for moves, splits, merges, or metadata fixes. Prefer targeted edits to existing groups; do not rebuild the whole draft unless it is broadly unusable.
4. When you have either finished the needed edits or decided that no concrete edit is needed, call `check_constraints` once.
5. If constraints are ok, immediately return the structured completion response. Do not call more tools, recount membership, restate edits, or summarize.
6. If constraints are not ok, fix the reported constraint issue, then call `check_constraints` again.

Call `read_groups` a second time only before `check_constraints`, and only when an edit changed membership and the mutation acknowledgement is insufficient to decide the next edit. Never call `read_groups` after `check_constraints` returns ok.

In batched mode, also watch for duplicate or split groups caused by earlier local draft passes. This is an additional refinement risk, not the only purpose of this pass.

Prioritize cross-scope comparisons, when draft origins are provided, before rechecking groups from the same draft scope.

# Refinement Checks

Look for concrete group-quality problems. Use the smallest edit that fixes the problem, and leave the draft unchanged when no concrete problem is visible.

Move misplaced items:

- Move a suppressed item to a `keep` group when its payload names a concrete repository route, action, state change, auth/session boundary, dangerous sink, protected resource, or sensitive data effect that needs analyzer review.
- Do not suppress an item merely because exploitability requires cross-file confirmation. If the payload gives a concrete anchor, keep it.
- Move a `keep` item to a `suppress` group only when the payload itself makes it obviously non-security, duplicate, framework-safe/default-safe, purely speculative, or too weak to form an analyzer case.

Split groups that are too broad:

- Split groups that combine different root issues, sinks, trust boundaries, or repair decisions.
- Split a `suppress` group when its members need materially different suppression reasons.
- Split groups whose only shared relationship is the same file, endpoint, feature, page, schema, log, workflow, package manifest, or directory.
- Do not split merely to make groups smaller; split only when membership crosses a real triage boundary.

Merge groups that are clearly duplicates:

- Merge groups only when the payloads make duplicate or near-duplicate status clear.
- Good merges describe the same root issue, same sink, same trust failure, or one item that is clearly a sub-aspect of another.
- Cross-file or cross-endpoint merges are good when the items form one direct exploit chain, one user-controlled value flowing to one sink, or one root trust failure.
- In batched mode, pay special attention to duplicate `keep` groups created in different draft batches.
- If merge certainty is not high, keep groups separate.
- Do not merge merely because items share a CWE, file, endpoint, feature, page, schema, log, workflow, package manifest, directory, endpoint family, broad theme, or weak contextual relationship.

Narrow inaccurate metadata:

- If a `keep` group summary claims a stronger layer, sink, trust boundary, or impact than its members support, narrow the summary/evidence or split the group.
- If a `suppress` reason overclaims why items are suppressible, narrow the reason or split the group.
- Do not rewrite metadata for style only.

Use targeted group edits when possible:

- Prefer `update_group` / `create_group` / `delete_group` for small refinements.
- Use `update_groups` / `create_groups` / `delete_groups` when the same refinement applies to multiple groups.
- For a full rewrite, call `delete_groups` for the existing groups and then `create_groups` for the new complete draft.
