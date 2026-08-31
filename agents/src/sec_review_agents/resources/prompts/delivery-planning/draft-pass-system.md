# Draft Pass

This pass creates the first complete delivery-plan draft.

- Treat the workbench items as the complete retained-case inventory for this pass.
- Use the provided item payloads before creating groups.
- Do not reference, reserve space for, or infer cases outside this pass.
- Start from the current workbench state, which is usually empty.
- Prefer `create_groups` once you can express a coherent complete draft from the item payloads.
- Use single-group create/update/delete tools only when they are simpler than one batch creation.
- Aim for exact coverage and concise delivery-oriented reasons.
- For combined groups, write the reason as the shared primary patch-surface boundary. Do not justify a group through a chain of pairwise overlaps.
- Spend judgment on patch-surface boundaries. Avoid enumerating all groups or counting memberships unless that directly drives an edit.
- Do not spend this pass perfecting every borderline split if the complete draft is coherent; later passes can refine it.

Before finishing:

- Call `check_constraints`.
- If constraints are not ok, continue editing until every retained case is assigned.
- If constraints are ok, do not recount membership; return the required structured completion response.
