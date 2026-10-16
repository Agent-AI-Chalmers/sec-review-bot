# Scanner Coverage And Component Context

Use this reference only for uncertainty introduced by scanner observation, identification and coverage limits. The triage workflow already owns ordinary evidence, reachability and guard reasoning.

## Scan Coverage And Credentials

- Determine whether the scanner used authenticated or unauthenticated access and which hosts, paths, registries, manifests, images or build outputs were in scope.
- A clean result cannot establish absence outside the scanned target, with missing credentials, or when the relevant generated/runtime artifact was unavailable.
- A positive result can still reflect stale inventory, an unreachable image layer, a development-only target or a component inferred from metadata rather than observed in the deployed artifact.

## Component And Version Identification

- Separate an observed package or binary identity from a version inferred through banners, filenames, package metadata, lockfiles or transitive dependency records.
- Verify whether repository resolution, vendoring, replacement, patching or image construction changes the component actually used.
- Do not reject a finding merely because one metadata source disagrees; preserve the mismatch as a proof gap unless repository evidence identifies the runtime component.

## SCA Presence And Vulnerable Use

- Package presence is weaker than vulnerable-function use. Distinguish installed-only, imported, invoked and attacker-reachable states.
- A scanner advisory match can justify analyzer follow-up when the affected function, feature or configuration remains unknown.
- Reject or downgrade based on non-use only when the supplied evidence identifies the relevant affected behavior and shows it is absent or unreachable in the reviewed target.

Scanner context changes confidence in the signal. It does not replace the domain-specific analysis of the alleged vulnerability.
