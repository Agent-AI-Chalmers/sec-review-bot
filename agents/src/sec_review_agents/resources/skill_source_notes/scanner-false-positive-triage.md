# Scanner False-Positive Triage Source Notes

These notes collect public sources for a bundled skill focused on evaluating noisy scanner-style security signals. The intended skill shape is not bug-bounty report handling. It is a lightweight false-positive reference for leads such as keyword matches, dangerous API sightings, dependency presence, weak reachability evidence, missing context, or broad hardening concerns.

## Candidate Skill Scope

Working name:

- `scanner-finding-triage`

Primary use:

- Help an agent decide whether a scanner-style security signal has enough repository-grounded evidence, context, and reachability to treat as security-relevant.
- Preserve useful uncertain leads without over-reporting keyword matches.
- Lower confidence where repository evidence already shows the scanner-style signal is not security-relevant.

Non-goals:

- Do not require full exploit reproduction.
- Do not decide final vulnerability validity.
- Do not replace deeper source/sink/guard analysis.
- Do not turn triage into bug bounty report review.
- Do not produce generic hardening findings.

## Source Selection

Use a small source set. Most public material on this topic is vendor marketing, bug-bounty workflow advice, or vulnerability-management prioritization. The candidate skill needs narrower support: scanner findings are leads, not proof; context and reachability reduce false positives; and rejection or downgrade rationale needs evidence.

This material is better suited to progressive disclosure than to a base triage prompt because it is conditional. It is useful when a lead looks scanner-like or false-positive-prone, but it should not bias every triage decision toward false-positive review. The base prompt can keep stage responsibilities stable; this skill can be loaded only when the agent wants more guidance on noisy signal evaluation.

Accepted primary sources:

- https://docs.rapid7.com/insightvm/false-positive-investigations
- https://edu.chainguard.dev/chainguard/chainguard-images/staying-secure/working-with-scanners/false-results/
- https://docs.devguard.org/explanations/vulnerability-management/false-positive-detection/
- https://www.cisa.gov/stakeholder-specific-vulnerability-categorization-ssvc

Accepted supplemental sources:

- https://www.first.org/cvss/specification-document
- https://owasp.org/www-project-vulnerability-management-guide/
- https://arxiv.org/abs/2601.22952
- https://arxiv.org/abs/2601.02941

### Selection Rationale

Rapid7 is accepted because it documents false-positive investigation as a scanner workflow problem: the scanner can be wrong because scan credentials, templates, and coverage are incomplete. It supports treating scanner output as a signal that needs verification, not as final evidence.

Chainguard is accepted because it gives concrete SCA/container false-positive examples: a package or vulnerable function may be present without being used or reachable. It maps cleanly to repository-grounded reachability checks.

DevGuard is accepted because its false-positive model is path-based: not affected claims should be tied to specific paths rather than blanket not-affected decisions. This is close to the project's evidence discipline.

CISA SSVC is accepted only as a lightweight prioritization vocabulary. Its value is the decision-tree posture, especially exploitation and technical impact. Do not import the full SSVC workflow into triage.

FIRST CVSS and OWASP VMG are supplemental only. They establish severity and vulnerability-management background, but they are too broad for this narrow signal false-positive filter.

The two recent SAST/agent triage papers are supplemental research context. They support the premise that SAST false-positive filtering is a real evaluation problem, but they should not become operational guidance unless the project adopts their benchmark assumptions.

Other vendor/tool articles and bug-bounty triage/reporting guides were reviewed but not retained. They are either too product-specific, too marketing-shaped, or too oriented toward mature vulnerability reports rather than early scanner-style signals.

## Source Findings

The public material does support a reusable triage skill, but the useful center is scanner false-positive management rather than vulnerability report triage.

Common themes:

- Scanner findings need context before they become actionable findings.
- False positives often come from incomplete scanner knowledge: version inference, configuration context, credential/scope limits, unreachable code, unused vulnerable functions, or missing environmental context.
- Reachability and exploitability matter, but triage should not require a full proof. It should identify whether there is a credible path worth deeper review budget.
- A finding can be true positive, false positive, informational, or mitigated by compensating controls. Collapsing all non-actionable cases into "false positive" loses useful audit and routing information.
- Rejections or downgrades should have evidence-backed reasons, not bare labels.
- CVSS/SSVC-style frameworks are useful for prioritization vocabulary, but they are too heavyweight for early triage unless reduced to a small number of context checks.

## Project Fit

The skill should target this review position:

```text
scanner-style signal -> false-positive/context check -> deeper review
```

It should answer:

- Is there a concrete suspicious construct, sink, trust boundary, or framework behavior in repository evidence?
- Is the candidate only a keyword match or hardening concern?
- Does the candidate contain enough file/path/function context for deeper review?
- Is there already visible guard, sanitizer, auth check, validation, isolation, or non-reachability evidence that makes the candidate likely noise?
- Is there an evidence-backed reason to lower confidence, reject the signal, or keep it live for deeper review?

It should not answer:

- Is the vulnerability fully proven?
- What exact severity or CVSS vector applies?
- Does the issue reproduce in a live target?
- Is the report in scope for a bug bounty program?

## Claim Ledger

These claims are reflected in the first `scanner-finding-triage` skill draft. Keep this ledger aligned with agent-facing references if the skill changes.

### Scanner-style output is a lead, not proof

Supported by:

- Rapid7 false-positive investigations: scanner results can be inaccurate because scanner configuration, credentials, templates, and coverage affect what the scanner can determine.
- DevGuard false-positive detection: "not affected" conclusions should be tied to specific paths and deployment context rather than blanket assumptions.

Project adaptation:

- The agent-facing skill says to prefer repository evidence over scanner inference.
- A signal needs evidence shape such as source, sink, guard, path, or effect before it should be treated as security-relevant.

### Presence is weaker than reachability

Supported by:

- Chainguard scanner false-results guidance: a package or vulnerable function can be present without being used or reachable in the image/application context.
- SAST/agent triage research: false-positive filtering is an active problem because static findings often require reachability and context reasoning.

Project adaptation:

- The agent-facing skill distinguishes installed-only, imported, called, and externally reachable dependency/function usage.
- It keeps plausible dependency signals alive when usage is unclear, but lowers confidence when relevant code is clearly unused, unreachable, or out of scope.

### Context and guards change confidence

Supported by:

- Rapid7 and DevGuard both frame false-positive handling around missing scanner context and manual investigation.
- CISA SSVC uses contextual decision points instead of treating raw vulnerability existence as the whole prioritization decision.

Project adaptation:

- The agent-facing skill asks whether validation, authorization, sanitization, allowlists, environment gates, path normalization, or framework controls cover the observed path before the sink.
- It lowers confidence when guards appear complete and keeps the signal live when guard ordering, scope, or semantics are ambiguous.

### Rejection or downgrade rationale should cite evidence

Supported by:

- DevGuard's path-based model favors specific path reasoning over blanket not-affected statements.
- Vulnerability-management sources generally treat triage decisions as records that need explanation, even when the final operational workflow differs.

Project adaptation:

- The agent-facing skill asks for concrete reasons such as no attacker-controlled source, no sink or security effect, complete guard coverage, unused dependency code, out-of-scope runtime context, or hardening-only concern.
- It avoids bare labels such as "false positive", "not exploitable", or "safe" without evidence.

Open design questions:

- How much SSVC/CVSS vocabulary should be allowed before the skill starts to imply severity scoring?
- The initial draft mentions SCA/package reachability as dependency presence vs actual use. Revisit if the skill should stay limited to repository code signals.

Likely exclusions:

- Do not import bug-bounty requirements such as full reproduction, bounty scope, reporter communication, or payout severity.
- Do not require CVSS/SSVC scoring at triage time.
- Do not reject a candidate solely because exploitability is not fully proven.
- Do not raise confidence solely because a dangerous API, dependency CVE, or vulnerability keyword appears in the repository.
- Do not treat "best practice missing" as a vulnerability candidate without a concrete security effect.

## Possible Agent-Facing Reference Structure

Keep the agent-facing skill general and small:

- Use when evaluating noisy scanner-style signals for reachability, context, and false-positive risk.
- Ask for evidence shape: suspicious construct, source, sink, guard, reachability, security effect.
- Do not force a fixed disposition vocabulary; let the calling agent decide how to route or label the signal.

Potential reference files:

- `references/reachability-and-context.md`
- `references/scanner-noise-patterns.md`
