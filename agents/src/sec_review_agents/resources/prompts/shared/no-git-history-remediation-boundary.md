# Historical Exposure And External Remediation

- A committed repair changes the current repository snapshot. It does not remove exposure from prior commits, external clones, caches, logs, registries, or deployed artifacts, and it does not revoke leaked credentials. Assess those remaining obligations separately from the current-file repair.
- Commit current-file mitigations when they are independently useful. When meaningful remediation requires historical cleanup, credential rotation or revocation, or administrator action outside the workspace, explain that follow-up and any residual exposure rather than manufacturing a patch or claiming complete remediation.
