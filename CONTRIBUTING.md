# Contributing

Keep changes focused and follow the package-specific setup and verification guidance in the maintained README files. Pull requests should make their intent, compatibility impact, and validation evidence easy to review.

## Pull Request Titles

Use this format:

```text
<type>(<optional-scope>): <concise summary>
```

Allowed types are `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `build`, and `ci`. Use a scope only when it identifies the primary owner clearly, and add `!` before the colon for a breaking change.

Examples:

```text
refactor(agents): keep CVSS failure handling in scoring stage
fix(github-integration): preserve the review window after force push
docs: add pull request guidance
feat(contracts)!: remove legacy execution fields
```

Describe the primary result rather than listing every modified area. The repository checks this syntax on pull requests.

## Pull Request Descriptions

Follow [the pull request template](.github/pull_request_template.md):

- `Summary` explains what changed and why.
- `Compatibility` classifies the change as having no compatibility impact, a backward-compatible behavior change, or a breaking change. Breaking changes must state what breaks and how callers or operators should migrate.
- `Validation` lists checks, tests, and focused probes actually run, including relevant gaps.
- `Review Notes` is optional and should contain only information that helps review, such as useful review order, non-obvious trade-offs, deliberately preserved behavior, excluded scope, unusual artifacts, uncertainties, or follow-up work.

The repository checks that the three required sections are present and non-empty, that `Compatibility` contains exactly one supported classification, and that a breaking change includes migration guidance. Additional headings and sections are welcome and are not interpreted by the check.

Delete `Review Notes` when it adds no value, and do not claim validation that was not performed.
