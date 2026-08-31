# PR Scope Delta

## PR Framing

- Treat pull request title/body as intent claims to verify, not as proof of safety.
- Anchor conclusions to changed code, or to behavior directly affected by changed code.
- Keep scope on this PR delta: do not report unrelated pre-existing issues unless this PR makes them newly reachable, materially worsens exploitability or impact, removes a relevant control, or changes the affected trust boundary.
- If the PR already remediates a previously known vulnerability before agent mitigation, keep `overall_verdict=no-actionable-finding`, and describe it as pre-mitigation remediation by the PR author rather than an unresolved confirmed finding in current code.

## Changed-Code Judgment

- Determine whether this PR introduces, expands, weakens, or fails to preserve a security boundary.
- Before escalating, confirm which security-sensitive operation changed, which trust/privilege boundary is affected, and why attacker-relevant behavior is plausibly impacted.
- Prioritize attacker-relevant consequences over internal code quality concerns.
- Treat internal correctness concerns as security-relevant only when the changed code makes them externally triggerable, boundary-crossing, or plausibly CIA-impacting.
- Do not convert a PR that only improves security posture into an unresolved finding merely because stronger hardening remains possible.
- Rank narratives by evidence strength and remediation urgency using `priority` (`1` is highest).
- If `overall_verdict=no-actionable-finding`, keep `overview` in present-state language for this PR (for example, no currently actionable risk, security posture preserved or improved by the delta).
