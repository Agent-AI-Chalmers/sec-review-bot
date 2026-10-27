# Context Loading

Language: English | [中文](CONTEXT_LOADING.zh.md)

Agents in this project receive context in two ways: some content arrives already rendered in the prompt, and some is left in the workspace for the agent to fetch with its own tools. Choosing between them per agent is a design decision, not a preference, and the two choices lead to different costs when the choice is wrong.

## Two Strategies

**Preload.** Content goes into the user prompt. The model reads it on the first turn with no tool call, no extra round trip, and no chance of fetching the wrong thing. The cost is unconditional: every request carries the content whether or not this task needs it, and the prompt stops being reusable when the underlying data changes.

**On demand.** Content stays in a mounted path and the agent fetches it with `read_file`, `grep`, `ls`, or `execute`. The model pays for a tool turn and some latency, chooses what to read, and can read only the part a question needs. The cost is paid only when a task actually needs the content.

## When Each Wins

The deciding question is not how large the content is. It is whether the content is **stable and always needed**:

- **Preload only when the content is both necessary and complete for the decision.** Necessary means every run of this agent needs it to answer at all; complete means the preloaded part is the whole input, not a sample an agent would have to extend. A case summary, a candidate list, or the inline files of a discovery chunk are this kind. Preloading something the agent then has to go and complete is the worst of both: a tool turn on top of a payload that may already be stale.
- **On demand** when the content is large, changes every run, or is only partly relevant. A repository, a diff, or an artifact the model may or may not consult is this kind.

A second signal is whether the agent would fetch the content anyway. If it inspects the repository regardless, preloading a rendered copy gives the model the same information twice and lets the prompt copy go stale. Measured here: when a pull request review prompt carried a pre-rendered list of changed files, the agent ran `git diff --name-only` or `git diff --stat` in three of four observed stage runs regardless, and removing the list cut the analyzer prompt from about 5,900 characters to about 550 with no loss of investigation.

Neither strategy wins outright. The closest comparison is [Skill Blocks: How Should an Agent Load Its Skill?](https://arxiv.org/html/2608.14943v1) (arXiv 2608.14943), which compares preloading a whole instruction document against loading parts on demand across five benchmarks:

> There is no universal winner. On SearchQA, hybrid reduces input by 27.4%, while heavily encouraged Skill Block loading increases it by 48.4%.

On-demand loading cut effective input by 52.8% to 73.0% on two other sets, and the same paper notes longer outputs can eat a small input saving. [Just-in-time retrieval](https://learn.agentpatterns.ai/context-engineering/just-in-time-retrieval/) arrives at the same rule from the context-engineering side: keep a small stable core in context and load the rest when a task arrives at it.

Preloading has its own support, and it is not merely the smaller-cost option.

**Position matters more than presence.** [Lost in the Middle](https://arxiv.org/abs/2307.03172) (TACL 2023) measured how well models use what they are given:

> performance is often highest when relevant information occurs at the beginning or end of the input context, and significantly degrades when models must access relevant information in the middle of long contexts, even for explicitly long-context models

Fetching on demand does not avoid that problem. A tool result lands in the middle of a growing conversation, competing with every later turn, while preloaded content sits in a fixed position the model reads first. On-demand reading buys selectivity, not guaranteed attention.

**Selective reading needs the agent to choose well.** A qualitative analysis of 900 agent traces found four recurring failure archetypes across three model families ([arXiv 2512.07497](https://ar5iv.labs.arxiv.org/html/2512.07497)):

> (1) premature action without grounding, such as guessing schemas instead of inspecting them; (2) over-helpfulness under uncertainty, where models substitute missing entities with plausible alternatives; (3) vulnerability to context pollution, in which distractor data induces incorrect reasoning; and (4) fragile execution under cognitive load, including malformed tool calls, generation loops, and inconsistent recovery from errors.

Two of these are costs that on-demand reading adds. When an agent decides what to fetch, it can act on an assumed shape instead of the real one, and it can fill a gap with something plausible rather than going back to the source. A preloaded payload removes that decision: the content is there whether or not the agent would have asked for it correctly. That is the point of preloading for a small, necessary input, and why a discovery chunk arrives complete and inline rather than mounted.

## How Each Agent Chooses Here

| Agent | Strategy | What is preloaded, or why not |
| --- | --- | --- |
| Repository discovery | Preload | The scanned files arrive inline with their diff removed from the prompt. Discovery mounts no workspace, so it cannot fetch anything: the input must be complete, and the prompt states that the inline contents are the whole input. |
| Repository triage | Preload | Candidate payloads arrive in the prompt. Triage mounts no workspace by design, and its judgement is defined as one made from the payload alone. |
| Pull request analyzer, mitigator, verifier | On demand | The workspace and `/history` are mounted, and the agent reads the window through git. The prompt carries the pull request text, reference, and prior stage results, but no rendered file list or diff. |
| Issue analyzer, mitigator, verifier | On demand | The workspace and `/history` are mounted; the issue text is preloaded because it is the signal under review. |
| Repository case analyzer, mitigator, verifier | On demand | The workspace, `/history`, and `/incremental-window` are mounted, and the case review input names the anchors rather than quoting the files. |
| CVSS | Mixed | Scoring needs the code once, so the workspace is mounted and the finding under scoring is preloaded. |
| Deletion cases | Preload, paths only | The case carries file paths and the window, never file contents. There is no current file to read, so the paths are the complete input; the content comes from the patch or git. |

## Applying This

**The wording carries as much weight as the choice.** Choosing on-demand delivery does not settle the outcome: how hard the prompt pushes a strategy changes it. In the comparison above, the same on-demand mechanism cut SearchQA input by 27.4% when presented as an option and increased it by 48.4% when the prompt heavily encouraged using it. Offer a path and let the task decide; do not instruct an agent to fetch things it has no reason to want.

When adding context to an agent, ask:

1. Is this content required for every run of this agent? If not, leave it on disk.
2. Will the agent inspect the same ground through its own tools anyway? If so, preloading a rendered copy duplicates work and risks going stale.
3. Is the agent even mounted to fetch it? If the backend exposes no paths, preload is the only option, and the prompt should say that the inline input is complete.

When preloading, keep it to the content a decision needs. A rendered listing of files that the agent can query itself is the case this project removed, not the model to follow.
