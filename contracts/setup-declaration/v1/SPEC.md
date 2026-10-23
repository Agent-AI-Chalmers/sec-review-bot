# Setup Declaration — v1

Language: English | [中文](SPEC.zh.md)

A setup declaration tells a review sandbox how to prepare itself before the agent starts. It is a small YAML file that a repository keeps at `.sec-review/setup.yml` on its **default branch**. When a review runs, the declaration is executed inside the Docker sandbox before the agent starts, so the agent begins in an environment with its dependencies installed.

The declaration is optional. A repository without one is reviewed in a declaration-free environment.

## Format

```yaml
setup:
  - run: pip3 install --no-input uv
    timeout_seconds: 300
  - run: uv sync --frozen
    working-directory: agents
    timeout_seconds: 600
```

Top level:

- `setup`: required; a list of steps executed in order.

Each step:

| Key | Required | Meaning |
| --- | --- | --- |
| `run` | yes | Shell command to execute in the container. Must be a non-empty string. |
| `working-directory` | no | Directory relative to the repository root. Must stay inside the root (no absolute paths, no `..`). Defaults to the repository root. |
| `env` | no | Mapping of environment-variable names to string values, exported before `run`. Names must be portable shell identifiers (`[A-Za-z_][A-Za-z0-9_]*`). |
| `timeout_seconds` | no | Per-step timeout. Defaults to 300. Must be a positive integer; the Execution Worker caps the effective value at `SEC_REVIEW_SETUP_STEP_MAX_SECONDS` (default 600). |

## Validity Rules

Parsing is strict. Anything outside the format above is rejected, never silently
ignored:

- the top level must be a mapping with only the `setup` key;
- `setup` must be a list of mappings (each a step);
- each step may carry only `run`, `working-directory`, `env`, and `timeout_seconds`;
- `run` is required and must be a non-empty string;
- `working-directory`, when present, must be a non-empty string that is relative and stays inside the repository root (no leading `/`, no `..` segment). Containment is checked lexically on the declared path; it does not resolve symlinks, so a symlink inside the repository is not followed by this rule (the declaration is trusted content, so this is containment, not a sandbox);
- `env`, when present, must be a mapping of string keys to string values, with keys matching the identifier pattern above. The declaration is parsed with the **YAML 1.2 Core schema**, so a key or value must be a string under that schema: `on`, `yes`, `off`, `no`, `y`, and `n` are plain strings, but `true`, `123`, and `null` are not and are rejected. This applies to `run` and `working-directory` too (see "Scalars and YAML dialects");
- `timeout_seconds`, when present, must be a positive integer (booleans are not integers). It must also be written in integer syntax: a float-syntax value (`1.0`, `1e3`) is rejected by inspecting the scalar's source text, because JS resolves it to an integer-valued number while Python resolves it to a float — without that check the two enforcers would disagree. Hex/octal integers (`0x10`, `0o10`) and signed decimals are accepted by both.

**Blank content is not a declaration.** An empty or whitespace-only file is treated exactly like a missing file: it is valid and means "no declaration". It is not an error.

**Only a regular file is a declaration.** The integration reads the path through the Contents API and accepts it only when GitHub reports the entry as a file. A directory entry, a symlink (whose API `content` is the target path, not the file body), or any other non-file entry is treated like a missing file: "no declaration". Symlinked declarations are therefore not followed — a repository that wants a declaration keeps it as a regular file at `.sec-review/setup.yml`.

**The declaration text is bounded.** The validated text travels inline in the workflow input, so it is capped at 64 KiB (UTF-8). GitHub Integration rejects an oversized file before submission; the Execution Worker and the input schema carry the same limit. A declaration that needs more than that is doing too much.

## Two Enforcers

The format is enforced by two independent implementations that must agree:

- the **Execution Worker** parser, in Python (`agents/src/sec_review_agents/entrypoints/setup_declaration.py`);
- the **GitHub Integration** validator, in TypeScript (`apps/github-integration/src/github/setup-declaration.ts`).

They have different jobs on the same rules:

- **GitHub Integration owns the content rules at the producer boundary**: it reads the file from the base repository's default branch, validates it, and rejects an invalid declaration **before** submitting the run — with the repository, ref, and path attached. A broken `.sec-review/setup.yml` on the default branch is a maintainer error that fails loudly rather than silently degrading to an unbootstrapped environment.
- The **Execution Worker re-validates as defense in depth** before executing. A *step* that fails is a best-effort `incomplete` environment (the review still proceeds); a declaration that does not *parse* at the worker fails the run, because the environment it asked for can never be prepared. GitHub Integration rejecting first is what makes an unparseable declaration at the worker a backstop: it should only happen if the two enforcers disagree (see "Scalars and YAML dialects") or an out-of-band caller supplied unvalidated text.

There is no JSON Schema for this contract. The rules that matter — a `working-directory` that cannot escape the root, an `env` name that cannot smuggle shell syntax, a timeout that is a positive integer — are decision logic, not a structural shape. Expressing them as JSON Schema would create a second definition ("schema says valid, parser says no") that the repository's contract rules explicitly avoid: schemas own structural shape, cross-field and policy rules stay with the code that enforces them.

## Corpus

[`corpus/`](corpus) holds input files shared by both implementations' tests, with [`corpus/manifest.json`](corpus/manifest.json) recording which cases each side must accept and which it must reject. Both the Python and TypeScript test suites execute the same files, so the two implementations cannot silently drift apart.

This corpus is the executable boundary of the format. Adding a rule means adding a case here and making both enforcers pass it: a case belongs here only when both implementations are required to classify it the same way.

### Scalars and YAML dialects

Both enforcers parse the declaration with the **YAML 1.2 Core schema**:

- the Execution Worker uses `yamlcore`'s Core-schema loader on top of PyYAML;
- GitHub Integration uses the `yaml` library with `schema: 'core'`.

Using one schema on both sides means every scalar resolves identically, so a declaration is accepted or rejected the same way by both. In particular, under the Core schema the words `on`, `yes`, `off`, `no`, `y`, and `n` are **plain strings**, not booleans — so `run: on` is the command string `on`, and `env: { yes: ok }` sets `yes=ok`. Unquoted `true`/`false` are booleans, `123` is a number, and `null`/`~` are null; those are rejected in any string-valued position (`run`, `working-directory`, `env` keys and values) because they are not strings. Quoting always forces a string (`run: "on"`), but it is not required for the Core-schema words.

**Explicit tags are rejected.** Neither side accepts an explicitly tagged node (`!!bool`, `!!int`, `!!str`, `!!seq`, `!!set`, ...). A declaration uses the plain Core schema, which already resolves booleans, numbers, and null; an explicit tag is never needed, and the two libraries disagree about them (`yaml` silently falls back to the raw string when a tag's scalar does not match, e.g. `!!bool on` resolves to `"on"`, while `yamlcore`/PyYAML raise). Rejecting every explicit tag keeps the two enforcers identical and turns a malformed tag into a clean declaration error instead of an internal traceback. Implicit resolution is unaffected: an untagged `on` is still the string `on` and an untagged `true` is still a boolean.

The Core schema is the intersection of what the two libraries agree on, and both were chosen for their 1.2 behavior:

- it is the modern default (YAML 1.1's implicit typing — `on` as a boolean, `1_000` and `12:30` as numbers, dates as timestamps — is deliberately gone);
- it is what GitHub Actions accepts in practice (workflow files use a bare `on:` key);
- it matches YAMLScript, the only current "one implementation, many language bindings" YAML library, whose scalar resolution is exactly this Core schema.

The one scalar rule that is *not* a schema difference is an `env` **key** that resolves to a non-string (`true`, `123`, `null`). GitHub Integration's `toJS()` stringifies such a key into a valid-looking name, while the Execution Worker keeps its type and rejects it, so the integration rejects it too (on the AST, before stringification). This keeps "GitHub Integration accepted it" and "the Execution Worker can parse it" the same statement for the whole key space.

The corpus covers the boundary: `valid-yaml12-word-strings.yml` pins that the Core-schema words are strings; `invalid-non-string-run.yml`, `invalid-non-string-working-directory.yml`, `invalid-env-value-boolean.yml`, and `invalid-env-non-string-key.yml` pin that real booleans/numbers are rejected.

Each implementation pins the schema with a test, so a library change that alters scalar resolution fails a test rather than silently shifting the boundary.

## Trust

The declaration is **executable repository content**. Trust in its *origin* is decided upstream, by GitHub Integration: it is read from the base repository's default branch, never from a fork or a payload-supplied ref. This contract governs only the *format*; it says nothing about where a declaration came from. Callers that supply a declaration out of band own its provenance.

Because a declaration runs in the same container, as the same user, with the same network as the agent, it can modify the workspace and anything the agent later reads. That is intended — a declaration is only useful if it can install dependencies in place — but it means a new source for a declaration is a new arbitrary-code-execution path in the agent's container.
