---
name: scanner-finding-triage
description: "Use as a reference for evaluating noisy scanner-style security signals, especially keyword matches, dangerous API sightings, dependency presence, weak reachability evidence, missing context, or broad hardening concerns."
---

# Scanner Finding Triage Reference Skill

Use this skill when reviewing security signals that may be scanner-style noise: keyword matches, dangerous API sightings, dependency presence, weak source/sink evidence, missing context, or broad hardening concerns.

This skill does not prove or disprove final vulnerability validity. It provides reference criteria for deciding whether a signal has enough evidence, context, and reachability to treat as security-relevant.

## Route

- For reachability, source/sink/guard shape, environment context, and dependency/SCA presence checks: read `/skills/scanner-finding-triage/references/reachability-and-context.md`.
- For common scanner noise patterns, hardening-only concerns, keyword matches, and evidence-backed rejection rationale: read `/skills/scanner-finding-triage/references/scanner-noise-patterns.md`.

This reference evaluates signal quality; it does not supply domain-specific exploit validation. Missing technical context is a proof gap, not evidence that the candidate is safe.

## Use Rules

- Treat scanner-style output as a lead, not proof.
- Prefer repository evidence supplied to the current stage over scanner inference. Distinguish evidence in the candidate payload from repository behavior independently inspected by the current agent.
- Let the calling agent choose its own disposition vocabulary.
- Keep final vulnerability confirmation separate from early signal triage.
- Do not convert best-practice gaps into findings without a concrete attacker-relevant effect.
