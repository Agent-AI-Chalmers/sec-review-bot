# Agent Memory System

Language: English | [中文](MEMORY_SYSTEM.zh.md)

References:

- [LangMem Core Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)
- [LangMem: How to Extract Episodic Memories](https://langchain-ai.github.io/langmem/guides/extract_episodic_memories/)
- [OpenAI Codex: Memories](https://developers.openai.com/codex/memories)
- [Claude Code: How Claude remembers your project](https://docs.anthropic.com/en/docs/claude-code/memory)
- [TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [OpenAI API: Working with evals](https://developers.openai.com/api/docs/guides/evals)
- [Persistent Memory | Hermes Agent](https://hermesagent.org.cn/en/docs/user-guide/features/memory)

Agent memory is a fast-moving area: new concept papers, open-source libraries, and product designs are still appearing. More complex approaches can be seen in systems such as TencentDB-Agent-Memory, which treats memory as full infrastructure with layered long-term memory, symbolic short-term memory, heterogeneous storage, and traceable retrieval.

This project currently learns mainly from Claude Code and Codex, especially Claude Code. Their public memory shape does not introduce complex layers, data indexes, query systems, or RAG infrastructure. It is closer to a skills-like file layout: memory documents are organized with progressive disclosure, only a routing index is injected at startup, and substantive rules, patterns, cautions, and examples live in narrower topic files.

In short, this kind of mechanism can be understood as:

```text
memory/
  MEMORY.md
  topics/
    python-path-traversal.md
```

Here, `MEMORY.md` is the startup-injected routing index, while `topics/*.md` stores concrete experience. Product-grade coding agents such as Claude Code / Codex can read and write memory while running, and they also come with mechanisms for automatically organizing memory.

This project implements a subset of Claude Code Memory:

- We only collect **security-review experience**. In LangMem terms, this is procedural memory: reusable review procedures and judgment experience. We do not collect user preferences or profile-like memory.
- Main agents currently only read curated memory and do not write memory directly; writing, filtering, and maintenance happen later through asynchronous workflows.

## Core Artifacts

- `transcripts`: process records left by main agents after completing a review.
- `observations`: reusable experience extracted from transcripts.
- `memory`: curated experience material.

> Here, `transcripts` means the archival process record left by an agent while doing one task. Other systems or contexts often call similar artifacts `trace`, `trajectory` (SWE-agent), or `rollout` (Codex).

```text
main agent
  ├─ write transcripts
  └─ read memory

extraction
  ├─ read transcripts
  └─ write observations

maintenance
  ├─ read observations
  └─ update memory
```

Extraction reads the stage transcripts from one review, such as analyzer, mitigation, and verification process records, and extracts reusable experience into observations. If there is no long-term reusable experience, it produces no observation.

Maintenance reads observations produced by extraction and folds useful experience into memory.

- It must not create new security-review experience from general knowledge; it can only organize existing memory or absorb sufficiently stable, reusable experience from selected observations.
- It can merge, compress, rewrite, rename, and split topics, shorten `MEMORY.md`, and delete obsolete or duplicate topic files after their content has been merged.
- It should not append observations verbatim into memory; weak, one-off, or run-specific observations should be skipped or compressed away.

## Lifecycle

Main agents only read the curated memory view and do not write memory directly. The prompt includes only the usage rule and a bounded `MEMORY.md` startup index; relevant topic files can then be read on demand through normal filesystem tools.

Experience production runs through an asynchronous path and does not affect the normal flow, meaning the review itself.

Roughly, the flow is a set of periodic checks:

- Source: after a review workflow publishes transcripts, it registers a pending extraction job.
- Extraction checks periodically and processes available work: the extraction schedule runs every 10 minutes by default, processes registered extraction jobs, and produces pending observations.
  - Multiple jobs can be processed concurrently.
- Maintenance checks periodically and runs when the threshold or age condition is met: the maintenance trigger schedule runs every hour by default. It starts maintenance only when at least 10 observations are pending, or when the oldest pending observation has waited at least one day.
  - Maintenance does not run in parallel; only one maintenance run exists at a time, though one run may process multiple observations.
  - `processed` means reviewed and handled. It does not mean the experience was necessarily absorbed into memory.

> The threshold of 10 is an empirical design choice and can be adjusted.

## Governance

Memory does not make extracted experience trustworthy by itself. Important experience still needs human audit, secondary cleanup, and a decision about whether it should remain in memory.

Memory should stay small and inspectable. Once it becomes a pile of notes, it should be cleaned up by merging, rewriting, and deleting, or important material should be promoted into prompts, skills, or other stronger surfaces.

> Note: for a **formal product**, this behavior needs caution even from a prompt-engineering perspective, because the improvement has to be demonstrated. But for a personal assistant agent, automatic skill generation can be considered; in that setting it can become a good self-governing system.

Retrieval belongs on purpose-built systems once material has outgrown memory. Customer records, user profiles, and documentation corpora need explicit schema, owners, permissions, retention policy, evaluation, and operating procedures; search or RAG does not make an oversized agent memory directory healthy.

`MEMORY.md` has a startup-injection cap. Exceeding that cap means memory already needs cleanup: maintenance should shorten the index and move details down into topic files, rather than treating truncation as a normal retrieval path.

## Design Tradeoffs

### No User Preference Records

The most typical example is Hermes Agent. It has `USER.md`, a file for recording user preferences and identity information. But this project is about code review, so there is no need to maintain so-called user preferences.

---

If the scenario changes, this can be added naturally: `USER.md` plus a `preference/` directory would be enough.

### No Hot Read/Write

This project does not put memory writes on the main agents' critical path. There are two core reasons:

1. Multi-agent concurrency. When multiple reviews, stage agents, or repository cases run at the same time, direct writes to long-term memory would create immediate write-conflict problems. File-based memory is especially exposed to this. Even if file locks serialize writes, lock waiting and write latency would be brought back into the main flow.
2. There is no supervisor here, and a single agent does not have a global view. By itself, it is usually hard for one agent to stably produce long-term experience of sufficient quality.

Therefore, the current implementation only lets main agents leave transcripts, while experience writing, filtering, and merging live in asynchronous extraction / maintenance workflows. This sacrifices some immediate memory experience, but gives clearer sources, a more stable main flow, and memory updates that are easier to audit and roll back.

---

But this must always be judged against the scenario. For example, hot read/write can be considered when:

- there is only one foreground agent/session
- there really is a supervisor
- memory is not only collecting experience, but also collecting user preferences

Unexpectedly, these three conditions usually appear together in personal assistant agents / coding agents.

### Other

- No complex DB or vector retrieval
- No `session_search` that allows agents to query details from previous conversations
- Automatic skill generation is feasible for personal agents, but questionable for formal products; see the governance section above
