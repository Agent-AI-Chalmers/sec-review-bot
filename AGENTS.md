# AGENTS.md

## Project Focus

For project facts, read the maintained docs:

- `README.md` for the repository overview.
- `agents/README.md` for the Python runner and agent implementation.
- `apps/github-integration/README.md` for the GitHub integration service.
- `docs/README.md` for deeper architecture, workflow, integration, and operations notes.

## Architecture And Contract Razor

Prefer deleting misleading compatibility, obsolete paths, and false abstractions over adding concepts. Add managers, registries, base classes, adapters, framework layers, or packages only when the current code is already failing without that boundary.

Split code only when the current boundary causes bugs, misleads maintainers, leaks internals, or forces repeated local knowledge. Prefer small destructive cleanup over broad redesign: remove stale names and compatibility paths, inline false indirection, tighten inputs and outputs, and add short responsibility comments only when they prevent misreads.

Internal implementation choices are fair game when they create confusion, bug risk, implicit state, or maintenance cost. Public contracts can change too, but require stronger evidence and an explicit compatibility choice:

- Break compatibility only when the user explicitly approves the break, project policy already allows it, or the old contract is clearly harmful.
- Preserve compatibility only when current callers still need it and the compatibility path does not keep the harmful boundary alive.

Do not keep old public names, fields, formats, or paths just because they once existed. If compatibility stays, state why and keep the surface narrow.

## Intentional Shapes

- `direct` local execution reuses Temporal activity functions because it cannot execute Temporal workflows directly. Do not treat the duplicated orchestration shape as a bug by itself.
- `single_agent` and `two_stage` issue workflows are intentionally retained and isolated.
- Repository `reviewInput` is the boundary that prevents repository-case stages from depending on raw triage-case fields.
- Triage and delivery workbench states are intentionally separate despite similar tool shapes. Do not add a shared workbench base class just to remove repetition.
- `review_stages.record` owns generic review-record projection only. Domain-specific result builders belong near their workflows.

## Prompts, Skills, And MCP

Treat prompt, skill, and MCP changes as architecture changes: they alter agent behavior even without Python or TypeScript control-flow changes. Use the maintained agent docs for the detailed boundaries:

- `docs/agent/SKILLS.md#design-principles-in-this-project` and `docs/agent/SKILLS.md#adding-or-updating-bundled-skills` for skill selection, materialization, mounting, and update rules.
- `docs/agent/MCP.md#choosing-mcp-tools`, `docs/agent/MCP.md#adding-mcp-integrations`, and `docs/agent/MCP.md#bash--skills-vs-mcp` for MCP tool boundaries, runtime placement, and integration tests.
- `docs/agent/RELATED_ISSUES.md` for prompt/cache/structured-output design concerns.

For agent-facing Markdown such as skills and memory notes, do not hard-wrap prose to a fixed column width; prefer semantic paragraphs and short lists.

Build the smallest usable version first, then iterate with evidence. Prefer focused smoke probes before broader cases; use broader or randomized probes only with a stable oracle. Document the commands or probes run, relevant observations, and regression checks. Prefer rollback or a smaller change when evidence is weak.

## Working Rules

### Code Changes

Read code before proposing architecture changes. When something looks like legacy or compatibility code, search for tests and comments before judging it.

Keep patches small and close to the existing ownership boundary. Do not generate broad migration plans unless explicitly asked. Do not add abstractions for future reuse, testing convenience, or conceptual purity.

Tests use pytest style: prefer function tests, fixtures, plain `assert`, and `pytest.raises`; `unittest.mock` helpers such as `Mock`, `AsyncMock`, and `patch` are fine when they keep the test direct.

Python targets 3.14. Do not add `from __future__ import annotations`; PEP 649 gives 3.14 lazy annotations, and postponed annotations can still confuse runtime metadata such as `TypedDict.__required_keys__`. See [PEP 649](https://peps.python.org/pep-0649/).

Follow [PEP 585](https://peps.python.org/pep-0585/) type style: prefer built-in generics such as `list[str]`/`dict[str, int]`, and import ABC generics such as `Callable`, `Iterable`, `Mapping`, and `Sequence` from `collections.abc`; keep typing-only constructs in `typing`.

### Python Checks

For Python changes under `agents/`, use the package-local checks from `agents/`:

Run them from `agents/`, and prefer `uv run ...` so the local `.venv` and package context are explicit; do not assume an activated shell environment.

```bash
uv run ruff check .
uv run black --check .
uv run mypy .
uv run pyright .
uv run python -m pytest
```

`uv run ruff check . --fix` is appropriate for local mechanical cleanup, especially import sorting and unused imports. Use the non-mutating commands above when reporting verification.

### TypeScript Checks

For TypeScript changes under `apps/github-integration/`, use the package-local checks from that directory:

```bash
pnpm run lint
pnpm run typecheck
pnpm test
```

`pnpm run lint:fix` is appropriate for local mechanical cleanup. Use the non-mutating `lint`, `typecheck`, and `test` commands when reporting verification.

### Repository Scripts

Treat `scripts/` as maintained repository consumers even though they are not part of the installed agents package or a stable public interface. When changing agents APIs, workflow contracts, artifact paths or formats, CLI arguments, transcript persistence, or runtime lifecycle helpers, search `scripts/` for affected imports, paths, filenames, and calling conventions and update them when needed. Do not assume that an experimental or repository-level script may retain an obsolete internal API.

Run the repository script checks from `scripts/`, using the agents project explicitly for Python dependencies:

```bash
uv --project ../agents run ruff check .
uv --project ../agents run black --check .
python -m compileall -q .
```

Run targeted `--help` or fixture-based smoke checks for scripts affected by a change. Keep these probes focused on the relevant entrypoints and contracts rather than treating scripts as another fully typed application package.

### Documentation Checks

After documentation moves or local Markdown link edits, run:

```bash
python scripts/check_markdown_links.py
```

For translated Markdown updates, run the repository-wide heading structure check:

```bash
python scripts/check_translated_doc_headings.py
```

For agent-facing Markdown such as skills and memory notes, prefer semantic paragraphs over fixed-column hard wrapping. To check likely hard-wrapped prose, run:

```bash
python scripts/check_markdown_wrapping.py
```

For translated contract documents, preserve code identifiers such as field names, interface names, workflow names, enum values, file paths, and directory names. Localize descriptive prose and section titles; project asset terms such as `schemas` and `fixtures` may remain in English when they refer to repository directories or test assets.

### General Change Rules

These rules also apply to new functionality, experiments, and internal ablations. Build the smallest usable version that fits the current code, then remove parts that become misleading or costly.

If a change requires preserving an old path, prefer deleting it instead of wrapping it again, unless current callers still require it and the user has not approved a breaking change.

For architecture review, report only the smallest set of changes that clearly removes real confusion, bug risk, implicit state, or maintenance cost.
