# Issue Input Pre-Analysis

Language: English | [中文](INPUT_PREANALYSIS.zh.md)

## What Actually Happens When An Issue Arrives

When an issue arrives, the agent usually only has `title` and `body`. The important point is that an issue is not a fact or an answer. It is directional input. The agent is not initially facing an already-established problem; it is facing a claim someone provided. That claim can be correct, partially correct, wrong about the root cause, overstated in impact, or already obsolete in the current code.

Therefore, the agent's first job is not "fix it". It is to decide whether the issue's claim is true, or at least whether it is a clue worth investigating.

There is also a practical constraint: the agent must not trust the issue directly, but it also cannot ignore the issue entirely. Without following the issue's statement at first, the agent often does not even know where to start looking in code.

For example, if an issue mentions inconsistent state, several helpers behaving differently, or a fallback problem, the agent should first follow those claims into the code and gather the first batch of evidence.

So the issue's role is to **provide the initial search direction**. The agent should **follow the issue while investigating, but not treat its words as facts**.

## The Two Risks: Trusting Too Fast vs Expanding Too Far

Once the agent starts following the issue, it can easily fall into two extremes.

### Risk 1: Trusting the Issue Too Early

The agent can easily think:

- the issue mentioned several objects, paths, or helpers
- I followed it and found related code
- it looks plausible
- so this is probably the problem

The result:

- fast convergence
- possibly wrong convergence
- the issue's explanation is treated as fact

The failure mode is: **trusting the issue too early and trusting the first explanation too early**.

### Risk 2: Expanding Forever for Completeness

The agent can also go the other way:

- the issue says different paths
- so I need to inspect every path
- the issue says state inconsistent
- so I need to inspect every related helper
- maybe there are other similar paths too

The result is constant searching, constant confirmation, refusal to stop, and eventual circling.

The failure mode is:

- **fear of missing something, so the agent keeps adding checks**
- **trying to be comprehensive and losing restraint**

The core tension in issue-review is simple:

- do not trust the issue too early
- do not expand without bound in the name of completeness

## What The Agent Must Do While Investigating

When investigating an issue, the agent should not take the issue body as one block of truth. It should keep decomposing it during investigation.

This does not mean leaving investigation to do static parsing. It means **reading code while correcting the agent's understanding of the issue narrative**.

During this process, the agent should keep handling at least four kinds of information.

### 1. What It Explicitly Says

This is the most direct part to use for code search.

Examples:

- which objects it mentions
- which states it mentions
- which helpers / paths / phases it mentions
- which symptoms it describes

### 2. What It Implies

These are not explicit conclusions, but they affect investigation scope.

Examples:

- If it says `different paths`, the agent should not inspect only one path.
- If it says `resulting state inconsistent`, the agent should inspect final state, not only local calls.

The role of these implications is to keep the agent from narrowing too much.

### 3. What It Leaves Unclear

This part is dangerous because the agent can easily fill it in by itself.

Examples:

- What exactly counts as correct state?
- What invariant should hold after repair?
- Which paths must behave consistently, and which can differ?

### 4. Where It Most Easily Causes Premature Conclusions

This does not mean the issue is deceptive. It means some phrasing makes it especially easy for the agent to choose a local explanation too early.

Examples:

- seeing one term and naturally but wrongly mapping it to a familiar concept
- seeing one symptom and treating a local explanation as the root cause

## A Simple Working Flow

Compressed into a simple working flow:

1. The issue arrives. Do not treat it as fact; treat it as an investigation entry point and follow it to the first code evidence.
2. While investigating, update the judgment of the issue's claims.
3. If the issue is not supported, stop.
4. If the broad direction is supported, carefully decide whether to expand the investigation scope.
5. Avoid both extremes throughout: trusting the first explanation too early and expanding forever for completeness.
6. End with a conclusion: whether the issue exists in the current repository; if it does, what the evidence and reasoning chain are and which narrative follows; if it does not, where the claim fails.
