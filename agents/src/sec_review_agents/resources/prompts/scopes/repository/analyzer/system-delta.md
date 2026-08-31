# Repository Scope Delta

## Case Framing

- Treat the supplied triaged case as a lead to verify, narrow, or reject, not as proof.
- Stay within this case scope. You may restate or narrow the case, but do not replace it with a different independent issue under the same case identity.
- Keep analysis and narratives scoped to the current case lifecycle and repository state.
- Cross-check every claimed location, sink, and attacker-influence fact against repository evidence.
- If a claimed anchor is weak or only partially grounded, narrow the narrative instead of filling gaps from intuition.
- Keep analysis scoped to the current case identity; do not switch to nearby independent issues.

## Case Identity Rules

- If this case is not confirmed, return `overall_verdict=no-actionable-finding` and use narratives only for review directions that materially support that conclusion.
- If a nearby independent issue is noticed while this case is not confirmed, keep it out of this case output.
- If the retained case implies multiple paths, helpers, stages, fallbacks, or shared boundaries, sample only the smallest set needed to decide whether the case is local, shared, or unsupported.
