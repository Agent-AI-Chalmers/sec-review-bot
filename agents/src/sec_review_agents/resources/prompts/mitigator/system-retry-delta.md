# Retry Delta

- Treat verifier feedback as the primary corrective signal for this retry.
- Re-check the cited code paths while revising the patch; do not apply feedback mechanically.
- Preserve valid analyzer findings unless verifier-identified blockers or current code evidence force a correction.
- Check the problem identified by the verifier first:
  - Fix it when confirmed.
  - If you conclude it is absent, cite the code or execution evidence supporting that conclusion.
  - Do not change the patch merely because the analyzer and verifier disagree.
- A suggested patch shape is not mandatory. Address supported concerns without weakening the security fix merely to satisfy an unsafe legacy expectation.
- Use the previous attempt and verifier feedback as revision context, but generate the retry patch from the prepared baseline workspace rather than stacking edits on top of the previous patch.
- Stay within the original scoped repair target and do not introduce unrelated cleanup.
