# Issue Input Analysis

Language: English | [中文](INPUT_ANALYSIS.zh.md)

## Starting From An Issue

An issue's title and body provide leads, not established facts. A report may be correct, describe only part of the behavior, misidentify the cause, overstate the impact, or refer to a problem already fixed.

The agent cannot trust the issue directly, but it cannot ignore the direction it provides either: without those leads, it may not know where to start looking in code. For example, if the issue describes inconsistent state, helpers behaving differently, or a fallback problem, the agent should follow those leads to find the first code evidence.

The issue **provides the initial search direction**; the agent **follows its leads without treating its claims as facts**.

*This page describes investigation under `audit`; see [review intent](../REVIEW_INTENT.md) for how `repair` uses trusted repair leads.*

## The Two Investigation Risks

Avoid both premature conclusions and unbounded investigation.

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
3. If the issue's claim is disproved, stop pursuing that claim; this does not directly terminate the entire workflow.
4. If the broad direction is supported, carefully decide whether to expand the investigation scope.
5. Avoid both extremes throughout: trusting the first explanation too early and expanding forever for completeness.
6. End with a conclusion: whether the issue exists in the current repository; if it does, what the evidence and reasoning chain are and which narrative follows; if it does not, where the claim fails.
