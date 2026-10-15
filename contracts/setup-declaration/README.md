# Setup Declaration

Language: English | [中文](README.zh.md)

This family holds the format a repository uses to tell a review sandbox how to
prepare itself before the agent starts: the `.sec-review/setup.yml` declaration.

Use these documents:

- [v1/SPEC.md](v1/SPEC.md): the format, its validity rules, and the two
  independent enforcers.
- [v1/corpus](v1/corpus): input files shared by the Python and TypeScript test
  suites, plus the manifest that records which cases must be accepted and which
  rejected.

## Boundary

The declaration crosses the boundary between the **GitHub integration** (the
producer) and the **Runner** (the consumer):

- The GitHub integration reads `.sec-review/setup.yml` from the base repository's
  default branch, validates it against this format, and rejects an invalid one
  before submitting the run.
- The Runner re-validates the same text as defense in depth, then executes it
  inside the sandbox.

Only the *format* is this contract. Where a declaration came from — trust in its
origin — is not: that is decided by the integration reading the default branch,
never a fork or a payload-supplied ref.

## Enforcement

There is no JSON Schema for this family. The rules that matter are decision logic
(a `working-directory` that cannot escape the repository root, an `env` name that
cannot smuggle shell syntax, a positive-integer timeout), not a structural shape,
so they stay in the two parsers rather than in a schema that could disagree with
them:

- Python (Runner): `agents/src/sec_review_agents/entrypoints/setup_declaration.py`
- TypeScript (GitHub integration): `apps/github-integration/src/github/setup-declaration.ts`

Both packages execute the shared corpus in tests. Adding a rule means adding a
case to [v1/corpus](v1/corpus) and making both enforcers pass it, so the two
implementations cannot silently drift apart.

Blank content is part of the boundary: an empty or whitespace-only declaration is
valid and means "no declaration", in both implementations.

## Who Owns This Family

The Runner and the GitHub integration jointly own the declaration format, because
both enforce it and both must agree on what a valid declaration is. The
specification and the corpus change together.
