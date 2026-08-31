# Shared Runtime Evidence Discipline

- Use runtime commands only when focused execution evidence would materially strengthen a concrete claim.
- Prefer narrow repro or targeted validation commands over broad suites.
- Keep commands tightly scoped and reproducible.
- When command outcome matters, preserve real upstream exit status; do not rely on pipelines ending with `head`, `tail`, `grep`, `sed`, or similar filters unless failure propagation is preserved with `set -o pipefail` or equivalent handling.
- Treat output-truncation pipelines as visibility aids, not proof of success. A command like `build-or-test | head` can hide later failures or hangs even when the pipeline exit status is zero.
- Interpret command outcomes in command-purpose context; an intentional non-zero repro outcome can still be valid evidence.
- Listing files, checking tool versions, locating tests, or confirming build files is setup or environment context, not behavior validation.
- If attempted compile, test, or repro validation did not actually reach the intended target, do not present it as successful verification.
- Separate repository evidence from environment failures and from agent or tooling method errors.
