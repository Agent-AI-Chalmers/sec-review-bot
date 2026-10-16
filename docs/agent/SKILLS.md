# Agent Skills

Language: English | [中文](SKILLS.zh.md)

This page describes how this project selects, prepares, mounts, and reads bundled agent skills.

## What Skills Are

A skill is a local capability description that the agent can read on demand. `SKILL.md` is the usual entry point; nearby files can hold narrower reference material.

Conceptual introductions:

- [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [Claude Skills overview](https://claude.com/docs/skills/overview)
- [Agent Skills Specification Overview](https://www.mintlify.com/anthropics/skills/spec/overview)

## Progressive Disclosure

Skills use progressive disclosure. Middleware exposes skill metadata first; when the agent needs a skill, it reads `SKILL.md` and any companion files.

Conceptual explanations:

- [Agent Skills Specification Overview: Progressive Disclosure](https://www.mintlify.com/anthropics/skills/spec/overview)
- [Progressive Disclosure in Agent Skills](https://www.marthakelly.com/blog/progressive-disclosure-agent-skills)

A typical directory shape is:

```text
skills/
  cwe/
    SKILL.md
    references/
      cwe-699-agent-navigation.md
```

`SKILL.md` is the entry point. Nearby files hold narrower references, and `SKILL.md` should tell the agent when to read them.

## LangChain / deepagents Model and Boundary

LangChain itself does not provide a governed skills model. deepagents `SkillsMiddleware` is closer to a lightweight filesystem protocol:

- The caller configures one or more source paths.
- The middleware looks for `<skill>/SKILL.md` under those source paths.
- The middleware reads `SKILL.md` metadata so the agent knows which skills are available.
- The agent later reads the full `SKILL.md` and companion files through filesystem tools.

`/skills` is not hardcoded by deepagents. The actual convention is:

```text
<source>/<skill>/SKILL.md
```

This project uses `/skills/` as the source path, so the agent sees `/skills/cwe/SKILL.md`. That path is a project convention, not a deepagents requirement.

deepagents only reads the source paths it is given. It does not choose or filter skills for a workflow. This project does that first: it copies the declared skills from package resources into a small temporary directory, then mounts that directory at `/skills`. The mounted view contains only the skills declared for that agent.

## Design Principles In This Project

### Skill Selection Level

Some external skills or commands cover capabilities this project already implements as workflows. Anthropic's [`security-review.md`](https://github.com/anthropics/claude-code-security-review/blob/main/.claude/commands/security-review.md) describes "perform security review", and OrchestKit's [`review-pr.md`](https://github.com/yonatangross/orchestkit/blob/main/plugins/ork/commands/review-pr.md) describes "review a PR". Here, those capabilities are built into the public workflows and their review stages rather than one standalone skill.

Bundled skills stay one layer below the project goal. They supplement the review workflow with reusable security knowledge; they do not redefine the workflow itself.

The bundled knowledge layer contains:

- CWE taxonomy navigation and scanner-finding triage;
- narrow domain references for web, CI, memory/numeric, cryptography, concurrency/resource, OS boundaries, parser/protocol, software supply-chain, and authorization security.

Domain ownership follows the mechanism under review. In particular:

- process invocation and filesystem authority belong to OS-boundary security;
- object construction belongs to parser/protocol security;
- web and CI own sensitive-data exposure only on their respective surfaces;
- dependency selection and install/build execution belong to supply-chain security;
- object and action authorization, service identity, delegated authority, and confused deputies belong to authorization security.

A reference is eligible when all of the following hold:

- its decision rules are stable enough to maintain;
- selective reading keeps ecosystem-specific material out of unrelated reviews;
- it changes a security judgment beyond ordinary source-to-sink, reachability, and authority reasoning.

Do not freeze volatile version/default matrices, vulnerability catalogs, or recommendation lists into bundled references. When a repository's declared platform version makes such information necessary, verify it from current primary documentation for that review.

### Developer Source Notes

Bundled skills keep developer-facing source notes under:

```text
sec_review_agents/resources/skill_source_notes/
```

These files map decision-changing rules to authoritative sources and applicability limits.

### Source Note Maintenance Contract

Maintain source notes per reference or small rule group. They are evidence ledgers, not reading lists. Record:

- what the reference owns and the adjacent mechanisms it does not own;
- each decision-changing operational claim, especially report/reject conditions, guard sufficiency, defaults and exceptions;
- an authoritative primary source with a section, API, rule or other useful locator;
- applicability limits, including language, platform, protocol, library and version assumptions;
- enough scope and exception detail to distinguish the supported rule from nearby but unsupported conclusions.

Identify repository reporting thresholds, workflow ownership and packaging decisions as project policy rather than attributing them to an external standard. Do not trace every explanatory sentence, but do not let a broad source link stand in for an unsupported operational rule. Recheck live defaults against the repository's dependency or target version when they affect the decision.

### Adding Or Updating Bundled Skills

When adding or changing a bundled skill:

1. Put the material under `sec_review_agents/resources/skills/<skill-name>/`. `SKILL.md` is the entry point.
2. `SKILL.md` metadata should be general enough for discovery, while precise enough that the agent can decide when to read it. Do not write the description as a one-off test hint.
3. Default to `SKILL.md` plus narrow `references/` files. Add templates or assets only for a concrete existing need; do not add `scripts/` unless the filesystem backend and permission model explicitly support skill execution.
4. Trace decision-changing rules to authoritative sources under `sec_review_agents/resources/skill_source_notes/`.
5. Declare the skill in the target agent or stage-local `skills.py`. Do not add skill names to docs, backend helpers, or runtime preparation code just to make them visible.
6. Ensure the target backend consumes the declaration, prepares the allowlisted view, mounts it at `/skills`, and enables skills middleware for that agent session.
7. Add focused tests for skill preparation and backend exposure. Follow the model-case structure documented under [`agents/tests/integration/llm/skill_cases/`](../../agents/tests/integration/llm/skill_cases/README.md).
