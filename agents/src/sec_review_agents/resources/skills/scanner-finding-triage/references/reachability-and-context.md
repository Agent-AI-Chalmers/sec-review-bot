# Reachability And Context Reference

Use this reference to evaluate whether a scanner-style signal has enough path context to be treated as security-relevant, or whether visible context makes it noise.

## Minimum Evidence Shape

A candidate is stronger when it identifies:

- source: attacker input, tenant-controlled data, untrusted artifact, external callback, fork/PR data, uploaded content, request parameter, stored user data, or dependency data crossing a boundary;
- sink: dangerous API, security-sensitive framework behavior, privileged action, file/network/process/database operation, deserialization/parser entry, or response/log exposure;
- guard: validation, sanitization, authorization, escaping, allowlist, environment gate, privilege boundary, or compensating control;
- path: route, function, workflow job, import/call graph, handler chain, middleware order, or artifact flow connecting source and sink;
- effect: data disclosure, code execution, privilege change, policy bypass, request forgery, filesystem access, or other concrete security impact.

Early triage does not need to prove every element. It should decide whether enough elements exist for deeper review to resolve the rest.

## Reachability Checks

Ask:

- Can an attacker or lower-privileged actor trigger the relevant code path?
- Is the sink reachable from a real route, handler, job, hook, parser, or exported API?
- Is the vulnerable function or component actually called, not merely installed, imported, or present in a lockfile?
- Does the path cross a trust boundary, or is it entirely trusted/admin/internal?
- Do guards execute before the sink and cover the attacker-controlled value?
- Is the behavior environment-specific, test-only, dead code, generated code, or example code?

## Guard Context

Lower confidence when repository evidence shows complete guard coverage:

- authorization checks cover the same object, tenant, role, or action;
- validation constrains the dangerous part of the input, not only a neighboring field;
- sanitization or encoding is context-appropriate for the sink;
- path normalization is followed by containment checks before filesystem access;
- allowlists are specific enough to prevent attacker-selected sensitive targets;
- middleware or framework controls execute before the route or handler.

Keep the signal live if guard ordering, scope, or semantics are ambiguous.

## Dependency And SCA Context

Presence is not reachability:

- a vulnerable package in a manifest is a lead, not proof of exploitability;
- imported code is stronger than installed-only code;
- a call to the vulnerable function, parser mode, option, or class is stronger than an import;
- exposure through a route, job, user-triggered parser, or privileged boundary is stronger than internal-only use.

For early triage, preserve dependency signals when repository usage is plausible but not yet proven. Treat them as noise only when the relevant code is clearly unused, unreachable, or outside the provided target.
