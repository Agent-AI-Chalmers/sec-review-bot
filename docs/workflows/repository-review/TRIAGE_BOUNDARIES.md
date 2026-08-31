# Triage Boundaries

Language: English | [中文](TRIAGE_BOUNDARIES.zh.md)

Triage input comes from the discovery stage. Discovery is responsible for producing security candidate signals with high recall, but a candidate is not a vulnerability conclusion. It can include duplicates, weak signals, different frontend/backend views of the same problem, and noise that is clearly not worth further analysis.

The triage stage does not confirm vulnerabilities. It organizes these candidates into problem units that the downstream analyzer can handle more easily:

- which candidates are clearly not worth further analysis and can be suppressed
- which candidates describe the same issue and can be merged into one case
- which candidates cannot be rejected at the shallow stage and should be conservatively kept

The downstream contract still receives `cases` and `suppressed_candidates`. The agent does not write those results directly. It only edits groups in the workbench, and the system exports results from the groups after constraints pass.

## Discovery and Triage Boundary

High recall does not mean every "security-flavored" observation should be sent to triage. Discovery should try to produce candidates within the vulnerability domain: attacker-controlled input, permission boundaries, dangerous sinks, sensitive data impact, or trusted-side state changes in concrete repository code.

Security process or best-practice suggestions such as CI scan frequency, security bot coverage, schema audit fields, placeholder copy, or generalized configuration hardening should preferably not be produced by discovery.

Even with tighter discovery, triage still needs suppression. Some candidates look suspicious in a single-file local view, but have no independent case value when compared with the broader inventory or code semantics. Examples:

- The client sends `filename`, `userId`, or `total`, but whether that is a vulnerability depends on whether the server re-authorizes, validates, or recomputes it.
- A schema has weak signals such as `password TEXT`, but the same plaintext password problem is already covered by runtime evidence from register/login code in the same batch or globally.
- The UI exposes an `/admin` link, but the true security boundary is whether the admin API performs server-side role checks.
- localStorage or React state can be modified by the user, but trusted server-side state is not affected by it.

Therefore, `merge` and `suppress` are not divided as "related means merge; unrelated means discard":

- `merge`: multiple items jointly describe the same root cause, sink, trust boundary, or repair point; the exported case is more complete and accurate after merging.
- `suppress`: the item itself is not a vulnerability-domain issue, is only weak supporting/repeated signal, or has no independent analysis or repair value after being covered by a stronger root-cause item.
- `keep`: the item has a concrete repository anchor, cannot be rejected at the shallow stage, and cannot clearly be merged into another keep group.

Desired state: discovery does not produce large amounts of non-vulnerability-domain noise, while triage still keeps suppression capability for candidates that are locally suspicious but globally invalid, independently valueless, or overstated.

## Suppress Boundary

Triage is a recall-first stage. The suppress threshold is high, and the keep threshold is low.

The boundary can be summarized with one question: does this item payload give analyzer a concrete repository-local anchor?

If the answer is no, for example it only says "missing validation", "possible information disclosure", or "not secure enough" in general terms without any concrete file location, route, action, data field, source/sink, permission boundary, or sensitive effect, it can be suppressed.

If the answer is yes, even weak evidence should usually be conservatively kept. At that point, the item provides a repository-specific anchor, and downstream analyzer can inspect cross-file authorization, session behavior, data flow, schema, callers, or dangerous sinks around that anchor.

Thus triage suppression is more like cleanup of "no analyzable object", not a final judgment that the vulnerability is false.

## Merge Boundary

Merge only happens when candidates clearly describe the same issue. Good merges usually have these traits:

- same root cause
- same dangerous sink
- same trust boundary
- same repair point
- frontend/backend separately describe the same trust failure
- one item is clearly a sub-aspect of another item

Do not merge only because of weak signals such as:

- same CWE
- same file but different operations
- same endpoint family
- all are `missing validation`
- all are generalized logging / hardening / policy suggestions
- a weak companion only provides contextual color and does not strengthen the same root cause, sink, or trust boundary

If merge certainty is not high, conservatively split.

Triage over-merge often appears as broad "issue theme" merging: for example, combining missing validation across multiple independent endpoints, unrelated client-side signals with no direct data flow, or a set of weak security suggestions in the same feature into one large case.
