---
name: scanner-finding-triage
description: "Use for scanner-specific uncertainty: inferred versions or components, SCA presence versus vulnerable use, scan credentials and coverage, generated or non-runtime targets, and severity metadata that does not establish finding validity."
---

# Scanner Finding Triage Reference Skill

Use this skill when a finding depends on what a scanner observed or inferred rather than directly established repository behavior.

This skill does not prove or disprove final vulnerability validity. It provides reference criteria for deciding whether a signal has enough evidence, context, and reachability to treat as security-relevant.

## Route

- For scan credentials and coverage, component or version inference, dependency/SCA presence and vulnerable-function use: read `/skills/scanner-finding-triage/references/reachability-and-context.md`.
- For scanner target mismatches, generated or non-runtime files, severity metadata and tool labels that overstate validity: read `/skills/scanner-finding-triage/references/scanner-noise-patterns.md`.

This reference evaluates signal quality; it does not supply domain-specific exploit validation. Missing technical context is a proof gap, not evidence that the candidate is safe.

## Use Rules

- Treat scanner-observed facts and scanner inferences separately. Prefer repository evidence supplied to the current stage when it contradicts an inferred component, version, mode or target.
- Let the calling agent choose its own disposition vocabulary.
- Keep final vulnerability confirmation separate from early signal triage.
