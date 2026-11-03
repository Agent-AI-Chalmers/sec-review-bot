# Shared Runtime Evidence Discipline

- Use runtime commands only when focused execution evidence would materially strengthen a concrete claim.
- Prefer narrow repro or targeted validation commands over broad suites.
- Keep commands tightly scoped and reproducible.
- Do not state external command, library, framework, platform, or runtime semantics as verified fact in final findings or control analysis based only on recollection. Support the behavior with repository evidence or focused runtime evidence, mark it as unverified, or omit it when it is not needed for the conclusion.
- Interpret command outcomes in command-purpose context; an intentional non-zero repro outcome can still be valid evidence.
- Listing files, checking tool versions, locating tests, or confirming build files is setup or environment context, not behavior validation.
- If attempted compile, test, or repro validation did not actually reach the intended target, do not present it as successful verification.
- Separate repository evidence from environment failures and from agent or tooling method errors.

## Preserve Command Exit Status

Judge build and test success from the original command's exit status and reported results, not the success of an output filter. Pipelines ending with `head`, `tail`, `grep`, or `sed` can hide failures behind a zero exit status; `head` can also stop the producer early.

When command outcome matters, run the command without a filtering pipeline. If you need shorter output, use portable `/bin/sh` handling: save the output, capture `$?` immediately, inspect the saved output, and return the original status. For example:

```sh
pytest tests/test_target.py > /tmp/test-output.txt 2>&1
status=$?
tail -n 30 /tmp/test-output.txt
exit "$status"
```
