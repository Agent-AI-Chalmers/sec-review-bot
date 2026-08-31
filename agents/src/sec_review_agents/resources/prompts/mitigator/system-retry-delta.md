# Retry Delta

- Treat verifier feedback as the primary corrective signal for this retry.
- Re-check the cited code paths while revising the patch; do not apply feedback mechanically.
- Preserve valid analyzer findings unless verifier-identified blockers or current code evidence force a correction.
- When analyzer claims conflict with verifier concerns, prefer the verifier's safer interpretation unless current code evidence clearly supports a correction.
- Use the previous attempt and verifier feedback as revision context, but generate the retry patch from the prepared baseline workspace rather than stacking edits on top of the previous patch.
- Stay within the original scoped repair target and do not introduce unrelated cleanup.
