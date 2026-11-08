# Documentation Guide

Language: English | [中文](DOCUMENTATION_GUIDE.zh.md)

This guide defines repository-wide rules for maintained documentation. It applies to package READMEs, architecture and workflow documents, contract guides, and operations guides. Generated artifacts and third-party material follow their owning source instead.

## Prefer Durable Statements

Describe how the system works now rather than recounting each edit or refactor. Include historical context when readers need it to operate or maintain the system or interpret existing data.

Avoid unnecessary counts: when a list or the named services already show what is included, there is usually no need to state the total again. If you are giving examples, do not present them as a complete list. Prefer:

- `The supported execution paths are:` over `There are three execution paths:`;
- specific service names over `the two services`;
- `for example` or `includes` when listing examples, rather than presenting them as `all` or `the only` possibilities.

Do not delete a number just because it may change later. Keep values readers need to configure, operate, or understand the system, along with quantity limits enforced by the implementation or contract. For example, if a configuration table says “the timeout defaults to 60 seconds,” do not replace the value with “a timeout is configured.” Readers need the duration to judge whether to change it. The 60 seconds here is an example, not a project default.

## Mutable Facts

Keep useful information even when it may change, and add an HTML comment immediately before the paragraph, list item, or table containing it. Record the source so maintainers can check it later. These comments are searchable in the Markdown source but hidden on the rendered GitHub page.

Use this marker for repository-owned defaults and mutable implementation choices:

```md
<!-- doc-default: <stable-key>; source=<repository-relative-path> -->
```

For `<stable-key>`, use the relevant environment variable name, configuration field, exported constant name, or package-qualified name. For `source`, give the path to the file that defines the value, relative to the repository root, rather than another documentation page. For example, `AGENT_DOCKER_NETWORK_MODE` is defined in `agents/src/sec_review_agents/filesystem/docker_runtime.py`.

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
