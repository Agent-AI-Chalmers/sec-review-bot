# CVSS v4 Scoring Agent

Language: English | [中文](CVSSV4.zh.md)

`cvss-v4-scoring` is part of the `repository-review` workflow.

## Why This Belongs Here

CVSS v4 is a standardized task. Once analyzer has provided sufficiently stable and structured vulnerability facts, scoring is essentially:

- decide each base metric
- generate the vector
- calculate the base score
- output severity and concise rationale

The hard part is the quality of the input facts. Calculating the score is straightforward.

An agent does the scoring so it can check metric-relevant facts in a limited repository context, which a plain mapping from analyzer summaries to scores cannot do. It uses repository evidence to calibrate judgments such as `AV/PR/UI/AT/SC/SI/SA`, but it must not turn into a second open-ended analyzer.

## Use In The System

CVSS v4 scoring gives a **standardized risk expression in the result presentation layer**. It is not the main internal signal for repair priority. Its main job is to **help human reviewers understand severity quickly**.

## Design Boundary

`cvss-v4-scoring` is responsible for:

- reading structured facts from analyzer output
- directionally verifying a small amount of evidence for the current case in a repository workspace copy
- deciding whether the current case is an independently scoreable CVSS object
- deciding metrics according to the CVSS v4 Base standard
- outputting vector, base_score, severity, and metric-level rationale
- returning `not-scored` for hardening, defense-in-depth, impact amplifier, or cases that only become exploitable through sibling vulnerabilities

`cvss-v4-scoring` is not responsible for:

- open-ended whole-repository exploration for new issues
- replacing analyzer vulnerability confirmation
- replacing mitigator repair strategy decisions
- replacing verifier effectiveness judgment

If it needs to read code, it should only perform targeted verification around the current case and avoid expanding issue scope.

## Repository Access

The CVSS agent does not only read analyzer results. It can also read a repository copy prepared for this stage. The copy allows tools to write indexes or caches; the prompt requires read-only investigation without modifying the code being scored.

The agent uses this access to resolve local uncertainty in scoring, not to rediscover vulnerabilities. For example:

- whether an endpoint requires authentication
- whether the vulnerability entry point is actually network-reachable
- whether impact is limited to the current service or repository evidence supports subsequent-system impact
- whether an analyzer location or source fact is consistent with code

Its code reading stays within these limits:

- prefer the selected narrative with `verdict=confirmed-vulnerability` and provided locations / affected paths
- open files that help decide one or two CVSS metrics
- do not perform whole-repository search-style re-audit
- do not expand unrelated issues found while reading into new cases
- do not use mitigator/verifier or post-fix state to affect original vulnerability scoring

## Not-Scored Boundary

The CVSS agent scores only **the current case**. It may see or discover other vulnerabilities while reading code, but it does not score them.

If the current case only amplifies another vulnerability's impact, for example "the container does not set `USER`, so impact is worse after successful RCE", then this case is a hardening recommendation or impact amplifier and has no independent CVSS score. The CVSS stage should then return:

- `scoring_status: not-scored`
- `overview`
- `not_scored_reason`

`not-scored` is a deliberate conclusion that the current case should not be scored. It does not mean scoring failed.

## Stage Placement And Input Requirements

- **Position**: after Analyzer, scoring the analyzed vulnerability facts; not after Mitigator / Verifier, to avoid contamination from post-fix information
- **Precondition**: Analyzer fact quality determines the scoring quality ceiling
- **Use**: presentation-layer standard score, not the core internal scheduling signal

## References

- FIRST CVSS v4.0 Specification Document: <https://www.first.org/cvss/v4-0/specification-document>
- FIRST CVSS v4.0 User Guide: <https://www.first.org/cvss/v4-0/user-guide>
