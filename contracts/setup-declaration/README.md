# Setup Declaration

Language: English | [中文](README.zh.md)

This contract holds the format a repository uses to tell a review sandbox how to prepare itself before the agent starts: the `.sec-review/setup.yml` declaration.

Use these documents:

- [v1/SPEC.md](v1/SPEC.md): the format, its validity rules, and its independent enforcers.
- [v1/corpus](v1/corpus): input files shared by the Python and TypeScript test suites, plus the manifest that records which cases must be accepted and which rejected.

## Boundary

The declaration crosses the boundary between **GitHub Integration** (the producer) and the **Execution Worker** (the consumer):

- GitHub Integration reads `.sec-review/setup.yml` from the base repository's default branch, validates it against this format, and rejects an invalid one before submitting the run.
- The Execution Worker re-validates the same text as defense in depth, then executes it inside the sandbox.

This contract covers only the format. It does not decide whether to trust where a declaration came from; the integration handles that by reading the default branch, never a fork or a payload-supplied ref.

## Enforcement

GitHub Integration and the Execution Worker apply the same format rules at the submission and execution boundaries. Their tests use the shared [v1/corpus](v1/corpus) to check acceptance and rejection, including path containment and YAML scalar handling. Adding a rule requires a corpus case that both sides pass; this contract does not maintain a separate JSON Schema.

Blank content is part of the boundary: an empty or whitespace-only declaration is valid and means "no declaration" in each implementation.

## Who Owns This Family

The Execution Worker and GitHub Integration jointly own the declaration format, because both enforce it and both must agree on what a valid declaration is. The specification and the corpus change together.
