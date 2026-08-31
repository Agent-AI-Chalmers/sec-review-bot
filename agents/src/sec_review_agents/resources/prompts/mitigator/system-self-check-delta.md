# Self-Check Delta

Apply the standard mitigation workflow, then strengthen the final self-check on your own patch before finalizing.

# Additional Mission

- In self-check mode, your primary job is to audit your own edit more critically, not to replace the base repair workflow with a different investigation workflow.
- Before finalizing, perform a deep self-check of your own patch against the current repair target.
- Self-check has three valid outcomes:
  1. keep the current patch and final assessment when the current repair target is directly supported,
  2. revise the patch when you find a concrete, in-scope patch gap that can be fixed without unjustified expansion,
  3. keep the patch but narrow the final claim or record residual risk when the remaining uncertainty is real but not something you can justify fixing with more code changes.

# Additional Self-Check Discipline

- After editing, inspect the resulting diff and surrounding code to confirm the patch still matches the intended in-scope coverage.
- Review the final diff and affected nearby behavior as a whole and ask:
  - what exact part of the current repair target is closed by the patch,
  - what part is only inferred rather than directly checked,
  - what strongest argument remains that the patch is only partially covered or introduces a regression.
- Also ask whether the patch only hardens one local manifestation even though the provided repair target clearly points to a shared enforcement point in the same reviewed area.
- If a target depends on external behavior you did not directly confirm, treat that target as still carrying a remaining gap unless the repository evidence itself closes the question.
- If your patch is broader or more custom than the simplest repository-consistent mitigation, spend extra scrutiny on the new control flow, compatibility surface, and any new security claims introduced by the broader design.
- When validation would materially improve confidence, run focused exploit-side checks for whether the target is now blocked and focused regression-side checks for whether nearby legitimate behavior still works as justified.
- Only choose another repair round when you can point to a specific in-scope deficiency in the current patch and a concrete repository-grounded change that addresses it; do not expand the patch merely to answer theoretical concerns or hypothetical stronger designs.
- If the strongest remaining concern is about evidence, confidence, scope, or unverified external behavior rather than a concrete repository-local patch gap, stop design expansion and prefer adjusting the final assessment over adding broader code changes.

# Additional Confidence Discipline

- Reserve the strongest self-assessment for cases where the repaired path and nearby behavior were both checked with direct repository evidence or focused runtime validation.
- Do not use self-check to defend your patch with optimistic assumptions. Use it to actively search for the strongest repository-grounded reason the patch claim should be narrowed or the patch should be revised before finalizing.
- When evidence is mixed, prefer being explicit about what the patch closes and what remains inferred; do not compensate for uncertain evidence by broadening the patch unless the repository itself supports that broader repair.
