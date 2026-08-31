# Repository Full-Scan Evaluation Concepts

This directory uses the following metric definitions for repository security-scan reports.

The evaluated target repositories are public repositories under `Agent-AI-Chalmers`. Scans run against each target repository's `main` branch, while benchmark answer keys live on the corresponding public `answer` branch:

| Target     | Repository                                                                      | Scanned branch | Answer-key branch | Answer-key file                                                                                                   |
| ---------- | ------------------------------------------------------------------------------- | -------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| Book Shop  | [Agent-AI-Chalmers/book_shop](https://github.com/Agent-AI-Chalmers/book_shop)   | `main`         | `answer`          | [vulnerabilities_report.md](https://github.com/Agent-AI-Chalmers/book_shop/blob/answer/vulnerabilities_report.md) |
| Raddit     | [Agent-AI-Chalmers/raddit](https://github.com/Agent-AI-Chalmers/raddit)         | `main`         | `answer`          | [VULNERABILITIES.md](https://github.com/Agent-AI-Chalmers/raddit/blob/answer/VULNERABILITIES.md)                  |
| WorldPress | [Agent-AI-Chalmers/worldpress](https://github.com/Agent-AI-Chalmers/worldpress) | `main`         | `answer`          | [VULNERABILITIES.md](https://github.com/Agent-AI-Chalmers/worldpress/blob/answer/VULNERABILITIES.md)              |

The reports evaluate an agentic repository-security workflow at multiple levels. Discovery produces candidates. Triage converts selected candidates into cases. Analyzer judgment confirms or rejects cases. Mitigation and verification operate on cases. Delivery planning and execution produce deliveries. Remediation results describe whether the final delivery set successfully fixes the validated or answer-key vulnerabilities.

These levels are reported separately because a repository scan has no complete universe of true negatives, and because answer keys in security benchmarks are often non-exhaustive.

## Metrics

### Answer Key

The benchmark answer key is the manually curated list of expected vulnerabilities for a target repository.

Answer keys in security benchmarks are often non-exhaustive: they define vulnerabilities that should be found, but they do not prove that every case outside the answer key is false. Therefore, answer-key metrics and reviewed-case metrics are reported separately.

### Benchmark Recall

Benchmark recall measures how many answer-key vulnerabilities are covered at a stated evaluation level.

```text
benchmark recall = covered answer-key items / all answer-key items
```

The coverage criterion must be stated with the level being evaluated. For discovery, an answer-key item is covered if the workflow produced a candidate for it. For triage, it is covered if the workflow converted that lead into a case. For analyzer judgment, it is covered if the analyzer validated it as a real vulnerability. For remediation, it is covered if the final repair plan includes a fix for it.

A missed answer-key item is a false negative for that evaluation level.

### Issue Category Coverage

Issue category coverage groups answer-key items by the kind of security reasoning needed to find them. This is used for scanner-versus-agent comparison because two approaches can have similar total recall while covering different classes of weakness.

The category taxonomy should be stated for each benchmark. A compact default taxonomy is:

- Sink-style code flaws: local data-flow or sink findings such as SQL injection, command injection, path traversal, SSRF, and XSS rendering sinks.
- Access-control and business-logic flaws: IDOR, missing ownership checks, privilege escalation, and role or policy mistakes.
- Authentication, session, and cryptographic design flaws: weak secrets, JWT validation mistakes, cookie/session weaknesses, and login-flow vulnerabilities.
- Missing security controls: absent CSRF protection, absent rate limiting, missing upload validation, and missing size limits.
- Sensitive-data and configuration exposure: debug endpoints, hardcoded credentials, password/hash exposure, secret leakage, and unsafe defaults.
- Dependency and supply-chain risk: vulnerable direct or transitive dependencies, scored separately from application answer-key recall unless the benchmark explicitly includes dependency issues.

Reports may merge or split categories when a benchmark requires a more precise taxonomy, but they should keep the grouping stable across compared tools and agentic runs.

### Reviewed Case Precision

Cases outside the answer key are manually reviewed instead of being automatically counted as false positives.

- Additional true positive: a real security issue outside the answer key.
- Duplicate: a case already represented by an answer-key item or another case.
- Non-security defect: a real repository defect, frontend-only observation, product issue, or defensive-hardening note that is not counted as a security true positive or false positive for reviewed precision.
- False positive: a case judged invalid after review.

When duplicate cases and non-security defects are excluded, reviewed case precision is:

```text
reviewed case precision = TP / (TP + FP)
```

The corresponding false discovery rate is:

```text
false discovery rate = FP / (TP + FP)
```

Duplicate cases, non-security defects, and additional true positives may still be discussed as review-load context, but they are not separate precision metrics.

Reviewed precision and false discovery rate are preferred over classical false positive rate because repository scanning does not have a well-defined set of true negatives:

```text
false positive rate = FP / (FP + TN)
```

### Analyzer Judgment

Analyzer judgment reviews whether cases are confirmed as real vulnerabilities.

- Confirmed: the analyzer determines that the case describes a real, exploitable or security-relevant weakness.
- Rejected: the analyzer determines that the case is not a valid vulnerability.
- Blocked: the analyzer cannot make a judgment because required evidence, structured output, or execution context is unavailable.

Analyzer results are reported separately from remediation because a correct vulnerability judgment does not imply that the final patch is complete or production-ready.

### Remediation Outcome

Remediation outcome reviews whether the final patch set fully remediates each answer-key item or confirmed vulnerability.

- Complete: the final repair removes the vulnerable sink/source or missing control for the answer-key item.
- Incomplete: the final repair covers a narrower instance but leaves part of the answer-key vulnerability class open.
- Missed: no final repair covers the answer-key item.

### Delivery Evaluation

Delivery evaluation asks: ideally, how many review-sized repairs should this benchmark produce; how many deliveries did this run actually produce; and where does the difference come from?

An ideal delivery is a manually defined review-sized repair for the benchmark answer key. It groups vulnerabilities that should normally be repaired together because they share a code boundary, security control, validation strategy, or reviewer mental model.

Ideal deliveries are not the same as answer-key items. A benchmark may contain many individual vulnerabilities, but a review-ready repair set should often consolidate related fixes. For example, several frontend XSS items may belong in one delivery if they share the same unsafe rendering pattern and sanitization strategy.

A report should define ideal deliveries before comparing runs. Each ideal delivery should list the answer-key items it covers and briefly explain why they belong together.

The first delivery metric is the delivery count gap:

```text
delivery count gap = actual deliveries - ideal deliveries
```

A positive gap means the run produced more deliveries than ideal, usually because related fixes were split apart. A negative gap means the run produced fewer deliveries than ideal, usually because unrelated fixes were mixed together or some ideal deliveries were missed. A zero gap does not prove good packaging; the report should still explain whether the actual deliveries map cleanly to the ideal deliveries.

After reporting the numbers, each run report should include a short discussion explaining where the delivery count gap comes from. This discussion is report-specific, not a separate metric or label system. For example, it may explain that one security repair was split across multiple deliveries, that unrelated repairs were bundled together, or that a missing vulnerability made an otherwise related delivery incomplete.

## Evaluation Levels

### Discovery and Triage Results

Discovery and triage results evaluate whether the workflow produced useful security candidates and converted them into cases.

This level is the closest comparison point to scanner output from tools such as Semgrep, CodeQL, or ZAP. It asks whether the workflow can surface security leads with enough precision to support later analysis.

Typical measurements at this level include:

- answer-key benchmark recall for discovered candidates or triaged cases
- reviewed case precision for triaged or delivered cases
- additional true positives outside the answer key
- duplicate cases, false-positive cases, and non-security defects as review-load context
- suppressed candidates
- discovery-stage or triage-stage false negatives

### Analyzer Judgment Results

Analyzer judgment results evaluate whether cases are validated as real vulnerabilities.

This level is the workflow's vulnerability-confirmation layer. It answers a different question from scanner-style discovery: not merely whether the workflow found a plausible lead, but whether it judged the lead correctly.

Typical measurements at this level include:

- confirmed vulnerabilities
- rejected cases
- blocked analyzer judgments
- analyzer-stage benchmark recall
- analyzer precision after manual review
- analyzer-stage false negatives

### Remediation Results

Remediation results evaluate whether the workflow successfully repairs the vulnerabilities it is expected to fix.

This level goes beyond traditional scanner evaluation, but it is in scope for an agentic vulnerability-remediation workflow because the system is expected to produce patches, not only reports.

Typical measurements at this level include:

- final repair-plan benchmark recall
- remediation outcome for answer-key items
- repair quality labels
- ideal deliveries
- delivery count gap
- delivery gap discussion
- patch correctness and completeness
- delivery integration success
- residual repair risks
