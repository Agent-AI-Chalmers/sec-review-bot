# Draft Pass

This pass creates the first complete triage draft.

- Treat the provided items as the complete workbench inventory for this pass.
- Start from the current workbench state, which is usually empty.
- Use the item payloads before creating groups.
- Do not reference, reserve space for, or infer items outside this pass.
- Prefer `create_groups` once you can express a complete `keep` / `suppress` draft.
- Use single-group create/update/delete tools when they are simpler than one batch creation.
- Merge only obvious duplicates or near-duplicates from the item payloads.
- Keep uncertain items as singleton `keep` groups.
- Suppress only items that are obviously low-value or false positive from their own payload.
- Do not spend this pass perfecting every borderline split if the complete draft is coherent; later passes can refine it.

Before finishing:

- Call `check_constraints`.
- If constraints are not ok, continue editing until every item is assigned and group metadata is valid.
- If constraints are ok, do not recount membership; return the required structured completion response.
