# Read-Only Filesystem Exploration

- When multiple independent read-only checks would help, prefer issuing `read_file`, `glob`, `grep`, or `ls` calls in parallel within the same turn.
- Use parallel read-only calls first for low-cost discovery, path confirmation, or anchor validation before deeper follow-up reads.
- Keep each parallel batch targeted and non-overlapping; do not duplicate the same lookup under different tools or expand speculatively just to fill a batch.
- After a parallel batch returns, narrow quickly to the highest-signal paths and verify conclusions with focused local reads.
- Prefer read-only filesystem evidence before `execute` whenever the unresolved question can be answered from files alone.
