# Documentation Guide

Language: English | [中文](DOCUMENTATION_GUIDE.zh.md)

This guide defines repository-wide rules for maintained documentation. It applies to package READMEs, architecture and workflow documents, contract guides, and operations guides. Generated artifacts and third-party material follow their owning source instead.

## Prefer Durable Statements

Write the current system directly. Avoid historical rewrite traces, migration narration, and statements framed around what an earlier version did unless history is necessary to operate or interpret persisted data.

Remove details that merely recount nearby content and can become false independently of it. Common examples include a number before a list, a count of roles already named in the same sentence, and a claim that an open set is complete. Prefer:

- `The supported execution paths are:` over `There are three execution paths:`;
- named owners over `the two services`;
- `includes` over `consists of` when the set may grow;
- `these artifacts`, `the workers`, or `the lifecycle axes` after the members have been named.

Do not remove a number merely because it may change. Keep it when readers need the value to configure, operate, or reason about the system, or when it expresses an enforced invariant. Examples include a retry limit, timeout, concurrency default, protocol cardinality, and the single-maintainer guarantee.

Use `always`, `never`, `only`, `exactly`, and exhaustive lists only for behavior enforced by code, a schema, an operational boundary, or tests. Otherwise narrow the statement to the context actually established.

## Mutable Facts

Important facts may still be expected to change. Keep them visible when they help readers, and place an HTML comment immediately before the paragraph, list item, or table that contains them. GitHub does not render these comments, while source search and documentation-review tools can find them.

Use this marker for repository-owned defaults and mutable implementation choices:

```md
<!-- doc-default: <stable-key>; source=<repository-relative-path> -->
```

Use an environment variable, configuration field, exported constant, or package-qualified name as `<stable-key>`. `source` must point to the repository file that owns the value, not another prose document.

Use this marker for dated external facts or conclusions that require periodic revalidation:

```md
<!-- doc-time-sensitive: <subject>; checked=<YYYY-MM-DD>; source=<URL-or-repository-relative-path> -->
```

The date records when the statement was checked, not when the document was edited. Update it only after revalidating the cited fact.

Markers identify review obligations; they do not make stale prose correct. When the source changes, update every marked statement that depends on it. English and translated documents must use the same marker key, source, and checked date.

Find marked facts with:

```bash
rg 'doc-(default|time-sensitive):' --glob '*.md' --glob '!docs/DOCUMENTATION_GUIDE*.md'
```

The exclusion keeps the marker templates in this guide out of the review-obligation set.

## Defaults And Examples

Keep a default in prose when it changes how a reader should operate or understand the system. Prefer one canonical configuration table when the value is merely reference data. A narrative may repeat the value when the consequence is the point, such as explaining how long recovery can pause or how a concurrency limit affects scheduling; mark that repetition with `doc-default`.

Label measurements and experiments as dated observations. Do not turn a sample result, current dependency behavior, or external release schedule into a permanent system property. Examples may use arbitrary numbers without markers when the text clearly identifies them as examples rather than defaults or guarantees.

## Documentation Review

When reviewing maintained documentation:

1. Remove redundant counts and exhaustive wording that add no meaning.
2. Preserve operationally useful defaults, limits, dates, and measured facts.
3. Add or update mutable-fact markers and verify their sources.
4. Check that absolute language is backed by an enforceable boundary.
5. Keep English and translated documents aligned in meaning, headings, and markers.
6. Run the documentation checks listed in `AGENTS.md`.
