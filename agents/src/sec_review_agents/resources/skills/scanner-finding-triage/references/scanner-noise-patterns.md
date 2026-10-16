# Scanner Context Mismatches

Use this reference when the scanner's target model, labels or scoring metadata may not describe the reviewed runtime artifact.

## Target And Mode Mismatch

- Check whether the scanner inspected source, a manifest, an image layer, a running service, a host package database or an externally observed endpoint. Evidence from one target does not automatically describe another.
- Generated files, fixtures, examples, test dependencies, migration artifacts and dormant image layers may be correctly detected but outside the reviewed runtime path.
- A tool may infer a framework feature, parser mode, operating system package or deployment option that the repository does not enable. Require the concrete inference and the repository fact that confirms or contradicts it.

## Labels And Severity

- Scanner labels such as `critical`, `exploitable`, `internet-facing`, `malware` or `secret` are conclusions to verify, not repository facts.
- CVSS or vendor severity describes the scored conditions of an issue; it does not establish that the affected component, configuration, call path or attacker prerequisites exist here.
- A keyword, API name or secret-shaped value can explain why a rule fired, but the label alone does not establish the value's authority, liveness or runtime use.

## Evidence-Backed Scanner Rejection

A scanner-specific rejection should name the mismatched scanner assumption, for example:

- the detected component is absent from the built or deployed artifact;
- the matched package is present but the advisory's affected function or mode is not used;
- the inferred version is contradicted by the resolved runtime component;
- the finding belongs to an excluded test, example, generated or dormant target;
- authenticated coverage or target inventory shows that the scanner evaluated a different boundary.

Do not use a generic scanner mismatch to reject a repository-supported vulnerability. If the supplied evidence does not resolve which target, version, component or mode applies, keep that fact as a proof gap.
