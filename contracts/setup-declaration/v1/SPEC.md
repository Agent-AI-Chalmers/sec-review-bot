# Setup Declaration — v1

Language: English | [中文](SPEC.zh.md)

A setup declaration tells a review sandbox how to prepare itself before the agent starts. It is a small YAML file that a repository keeps at `.sec-review/setup.yml` on its **default branch**. When a review runs, the declaration is executed inside the Docker sandbox before the agent starts, so the agent begins in an environment with its dependencies installed.

The declaration is optional. A repository without one is reviewed in a
declaration-free environment.

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
| `timeout_seconds` | no | Per-step timeout. Defaults to 300. Must be a positive integer; the runner caps the effective value at `SEC_REVIEW_SETUP_STEP_MAX_SECONDS` (default 600). |

## Validity Rules

Parsing is strict. Anything outside the format above is rejected, never silently
ignored:

- the top level must be a mapping with only the `setup` key;
- `setup` must be a list of mappings (each a step);
- each step may carry only `run`, `working-directory`, `env`, and `timeout_seconds`;
- `run` is required and must be a non-empty string;
- `working-directory`, when present, must be a non-empty string that is relative
  and stays inside the repository root (no leading `/`, no `..` segment);
- `env`, when present, must be a mapping of string keys to string values, with
  keys matching the identifier pattern above;
- `timeout_seconds`, when present, must be a positive integer (booleans are not
  integers).

**Blank content is not a declaration.** An empty or whitespace-only file is treated exactly like a missing file: it is valid and means "no declaration". It is not an error.

## Two Enforcers

The format is enforced by two independent implementations that must agree:

- the **Runner** parser, in Python (`agents/src/sec_review_agents/entrypoints/setup_declaration.py`);
- the **GitHub integration** validator, in TypeScript (`apps/github-integration/src/github/setup-declaration.ts`).

They have different jobs on the same rules:

- The **integration owns the content rules at the producer boundary**: it reads the file from the base repository's default branch, validates it, and rejects an invalid declaration **before** submitting the run — with the repository, ref, and path attached. A broken `.sec-review/setup.yml` on the default branch is a maintainer error that fails loudly rather than silently degrading to an unbootstrapped environment.
- The **runner re-validates as defense in depth** before executing. A *step* that fails is a best-effort `incomplete` environment (the review still proceeds); a declaration that does not *parse* at the runner fails the run, because the environment it asked for can never be prepared. The integration rejecting first is what makes an unparseable declaration at the runner a backstop: it should only happen if the two enforcers disagree (see "Scalars and YAML dialects") or an out-of-band caller supplied unvalidated text.

There is no JSON Schema for this contract. The rules that matter — a `working-directory` that cannot escape the root, an `env` name that cannot smuggle shell syntax, a timeout that is a positive integer — are decision logic, not a structural shape. Expressing them as JSON Schema would create a second definition ("schema says valid, parser says no") that the repository's contract rules explicitly avoid: schemas own structural shape, cross-field and policy rules stay with the code that enforces them.

## Corpus

[`corpus/`](corpus) holds input files shared by both implementations' tests, with
[`corpus/manifest.json`](corpus/manifest.json) recording which cases each side
must accept and which it must reject. Both the Python and TypeScript test suites
execute the same files, so the two implementations cannot silently drift apart.

This corpus is the executable boundary of the format. Adding a rule means adding a case here and making both enforcers pass it: a case belongs here only when both implementations are required to classify it the same way.

### Scalars and YAML dialects

The two enforcers use different YAML libraries, and the libraries implement
different scalar-resolution rules:

- the runner uses PyYAML (YAML 1.1), where `on`, `yes`, `off`, and `no` resolve
  to booleans;
- the integration uses the `yaml` library (YAML 1.2), where those same words
  resolve to strings.

The two cannot be made to agree on every ambiguous scalar (each library's "version" option trades one disagreement for another), so the shared corpus does not cover unquoted scalars whose *kind* differs between the dialects. Both implementations do agree on every value the corpus does contain — booleans and numbers (`true`, `false`, `123`) are non-strings in both dialects, and quoted strings are strings in both.

The practical rule for authors is therefore: **quote any value that could be read as a non-string** — `run: "on"`, `working-directory: "no"`. An unquoted boolean-like value is a portability trap: the integration may accept it as a string while the runner, parsing a different dialect, rejects it (or vice versa).

Each implementation pins its own dialect with a test, so a library upgrade that
changes scalar resolution fails a test rather than silently shifting the boundary.

## Trust

The declaration is **executable repository content**. Trust in its *origin* is decided upstream, by the GitHub integration: it is read from the base repository's default branch, never from a fork or a payload-supplied ref. This contract governs only the *format*; it says nothing about where a declaration came from. Callers that supply a declaration out of band own its provenance.

Because a declaration runs in the same container, as the same user, with the same network as the agent, it can modify the workspace and anything the agent later reads. That is intended — a declaration is only useful if it can install dependencies in place — but it means a new source for a declaration is a new arbitrary-code-execution path in the agent's container.
