# Scanner Noise Patterns Reference

Use this reference to recognize candidates that often come from scanner-style over-reporting. These patterns should lower confidence unless repository evidence shows a concrete security path.

## Keyword And API Sightings

Common noisy shapes:

- dangerous function name without attacker-controlled input;
- `eval`, shell, SQL, deserialization, file path, or HTTP client API used only with constants or trusted internal values;
- framework escape hatch present but guarded by trusted-only call sites;
- security term appears in a file name, comment, test, fixture, or documentation.

Raise confidence only when the candidate identifies source, sink, and missing or ambiguous guard coverage.

## Hardening-Only Concerns

Usually keep non-confirmed unless tied to concrete impact:

- missing rate limiting with no abuse path;
- broad permissions with no untrusted trigger;
- absent security headers with no demonstrated browser-side effect;
- unpinned dependencies or actions with no attacker-controlled update path;
- generic debug/logging concern without sensitive data or unauthorized log access;
- missing scanner, linter, CodeQL, Dependabot, or policy hygiene.

Hardening can be informational, but it should not become a vulnerability candidate by itself.

## Context Mismatch

Lower confidence when the finding depends on assumptions contradicted by repository evidence:

- scanner inferred a version, feature, or mode that the repository does not use;
- flagged code is test-only, sample-only, migration-only, generated, or unreachable;
- the dangerous value is fixed, normalized, allowlisted, escaped, or checked before the sink;
- the route is internal/admin-only and protected by visible controls;
- the candidate crosses no meaningful privilege, tenant, network, or data boundary.

## Evidence-Backed Rejection Rationale

A useful rejection or downgrade explains one concrete reason:

- no attacker-controlled source reaches the sink;
- no sink or security effect is present;
- complete guard coverage is visible before the sink;
- dependency/function is present but not used in reachable code;
- code is outside runtime scope, target scope, or provided repository materials;
- concern is hardening-only and lacks a concrete exploit path.

Avoid bare labels such as "false positive", "not exploitable", or "safe" without evidence.
