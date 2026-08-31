# CVSS v4 Scoring Agent

Language: English | [中文](CVSSV4.zh.md)

`cvss-v4-scoring` is part of the `repository-review` workflow.

## Why This Belongs Here

CVSS v4 is a standardized task. Once analyzer has provided sufficiently stable and structured vulnerability facts, scoring is essentially:

- decide each base metric
- generate the vector
- calculate the base score
- output severity and concise rationale

The hard part is therefore input fact quality, not score calculation itself.

The reason to use an agent is to let CVSS scoring verify metric-relevant facts in a limited, read-only repository context instead of merely mapping analyzer summaries to scores. In other words, it should use repository evidence to calibrate key judgments such as `AV/PR/UI/AT/SC/SI/SA`, but it must not become an open-ended analyzer again.

## Use In The System

CVSS v4 scoring is used for **standardized risk expression in the result presentation layer**, not as the main internal signal for repair priority.

Its main role is to **help human reviewers quickly understand severity**.

## Design Boundary

`cvss-v4-scoring` is responsible for:

- reading structured facts from analyzer output
- directionally verifying a small amount of evidence for the current case in a read-only repository workspace
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

The CVSS agent does not only read analyzer results. It can also see the read-only repository and read some files.

The purpose of this capability is not to rediscover vulnerabilities. It is to resolve local uncertainty in scoring, for example:

- whether an endpoint requires authentication
- whether the vulnerability entry point is actually network-reachable
- whether impact is limited to the current service or repository evidence supports subsequent-system impact
- whether an analyzer location or source fact is consistent with code

Therefore, its code reading boundary is:

- prefer the selected narrative with `verdict=confirmed-vulnerability` and provided locations / affected paths
- open files that help decide one or two CVSS metrics
- do not perform whole-repository search-style re-audit
- do not expand unrelated issues found while reading into new cases
- do not use mitigator/verifier or post-fix state to affect original vulnerability scoring

## Not-Scored Boundary

The CVSS agent only scores **the current case itself**. This means it may see or discover other vulnerabilities, but it must score only the current case.

If the current case only amplifies another vulnerability's impact, for example "the container does not set `USER`, so impact is worse after successful RCE", then this case is a hardening recommendation / impact amplifier, not an independent CVSS object. In that case, the CVSS stage should return:

- `scoring_status: not-scored`
- `overview`
- `not_scored_reason`

This is not a scoring failure. It is a clear conclusion that the current case should not be scored.

## Conclusions Consistent With Implementation

- **Position**: after analyzer is correct and implemented
- **Not after repair**: it does not run after mitigator/verifier, avoiding contamination from post-fix information
- **Use**: presentation-layer standard score, not the core internal scheduling signal
- **Precondition**: analyzer fact quality determines the scoring quality ceiling

## References

- FIRST CVSS v4.0 Specification Document: <https://www.first.org/cvss/v4-0/specification-document>
- FIRST CVSS v4.0 User Guide: <https://www.first.org/cvss/v4-0/user-guide>
