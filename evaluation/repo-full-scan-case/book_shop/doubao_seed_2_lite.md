# Book Shop Repository Full Scan: Doubao Seed 2.0 Lite

## Scope

This report compares the repository scan workflow output for the Book Shop benchmark against the manually injected ground truth in [book_shop/vulnerabilities_report.md](https://github.com/Agent-AI-Chalmers/book_shop/blob/answer/vulnerabilities_report.md).

- Target repository: `book_shop` main workspace
- Ground truth: [book_shop/vulnerabilities_report.md](https://github.com/Agent-AI-Chalmers/book_shop/blob/answer/vulnerabilities_report.md)
- Model configuration: `anthropic/doubao-seed-2.0-lite` for all repository stages
- Run identifier: `local-run-20260505T185514Z-252339bb`
- Run date: 2026-05-05

Metric definitions follow [Repository Full-Scan Evaluation Concepts](../README.md).

---

```bash
screen -S bookshop-Doubao-Seed-2.0-lite

# cd sec-review-bot

source .venv/bin/activate

sec-review-agents-run-local-repository \
  --repo book_shop \
  --target-branch main \
  --output-dir .agent-workspace/bookshop-repo-scan-Doubao-Seed-2.0-lite
```

---

These counts describe how the multi-stage workflow behaved internally. They are diagnostic rather than main evaluation metrics.

**The Number Story (End-to-End):** 75 cases -analyzer-> 74 confirmed cases (66 confirmed risk + 8 confirmed defect, plus 1 no-actionable finding) -mitigate & verifier-> 73 delivered cases -delivery-> 44 deliveries (11 combined + 33 single).

## Evaluation Summary

| Discovery and triage           | Result                                        |
| ------------------------------ | --------------------------------------------- |
| Benchmark recall at case level | 18 / 19 answer-key items became cases (94.7%) |
| Candidate and case volume      | 103 candidates, 75 cases                      |

| Analyzer judgment                  | Result                                                            |
| ---------------------------------- | ----------------------------------------------------------------- |
| Benchmark recall at analyzer level | 17 / 19 answer-key items confirmed or partially confirmed (89.5%) |
| Confirmed cases                    | 74                                                                |

| Remediation                                 | Result                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Benchmark recall at final repair-plan level | 13 / 19 answer-key items covered or partially covered (68.4%)                                          |
| Remediation outcome                         | 9 complete, 4 incomplete, 6 missed                                                                     |
| Delivered cases                             | 73 cases across 44 deliveries                                                                          |
| Non-delivered cases                         | 2 cases blocked before final delivery                                                                  |
| Delivery quality                            | 9 ideal deliveries, 44 actual deliveries, delivery count gap +35                                       |
| Residual repair risks                       | fewer blocked cases than before, but several answer-key items still stop short of a clean final repair |

| Manual review of final cases                                      | Result                                                                                         |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Clear answer-key misses at final repair level                     | price tampering, reflected XSS, mass assignment, open redirect, balance race, second-order SQL |
| Confirmed or delivered but not counted as effective final repairs | weak JWT secret, CSRF/profile-update, order history IDOR, reflected XSS, second-order SQL      |
| Reviewed case precision                                           | TP / (TP + FP) = 70 / (70 + 0) = 100.0%                                                        |
| False discovery rate                                              | FP / (TP + FP) = 0 / (70 + 0) = 0.0%                                                           |
| Extra cases after manual review                                   | valid hardening surfaces plus several non-answer-key defects                                   |

Estimated run cost: $3.088899.

This final run produced a much larger delivery set, and most cases reach a final delivery artifact. The final artifacts are useful for several high-risk sinks, but they still do not provide complete answer-key repair coverage.

## Benchmark Recall Against the Answer Key

The Book Shop answer key has 19 numbered sections. This report maps lettered sub-items to their parent sections.

|   # | Ground-truth vulnerability                           | Workflow result  | Evidence / case                                                                                                                                                                                                                                                                  |
| --: | ---------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | SQL injection (search/login/register)                | Incomplete       | Search/page SQL injection cases were delivered, including `SQL Injection via Unsafe Raw Query Interpolation in Books Search API`. Login/register raw-query cases were present, but the final repair set was not counted as complete for the full answer-key SQL-injection scope. |
|   2 | JWT bypass (alg:none + weak secret)                  | Incomplete       | `Unrestricted acceptance of JWT 'none' algorithm allows authentication bypass` and `Hardcoded default JWT secret` reached delivery, but the final repair set was not counted as complete for the full weak-secret/token-validation scope.                                        |
|   3 | Path traversal in `/api/assets?file=`                | Found            | `Path Traversal Arbitrary File Read in Asset Serving Endpoint` reached final delivery.                                                                                                                                                                                           |
|   4 | IDOR (order history + review deletion)               | Incomplete       | Review deletion ownership and cross-user order history cases reached delivery, but the final repair set was not counted as complete for both ownership paths.                                                                                                                    |
|   5 | Client-controlled checkout total / price tampering   | Missed at repair | Checkout manipulation cases reached delivery, but manual review did not count them as an effective final repair for the answer-key price-tampering issue.                                                                                                                        |
|   6 | Plaintext password storage                           | Found            | `User Passwords Stored in Plaintext Without Hashing in Schema` reached final delivery.                                                                                                                                                                                           |
|   7 | Stored XSS in reviews                                | Found            | `Stored Cross-Site Scripting via Unsanitized Review Content` reached final delivery.                                                                                                                                                                                             |
|   8 | Reflected XSS in search query                        | Missed at repair | A reflected-XSS case reached delivery, but manual review did not count it as an effective final repair for the answer-key `dangerouslySetInnerHTML` search path.                                                                                                                 |
|   9 | Profile mass assignment / privilege escalation       | Missed at repair | Mass-assignment cases reached delivery, but manual review did not count the final repair set as effective for the answer-key profile privilege-escalation path.                                                                                                                  |
|  10 | CSRF via cookie-authenticated profile update         | Incomplete       | A state-changing top-up CSRF case and session-cookie hardening reached delivery, but the final repair does not fully cover the answer-key profile-update CSRF path.                                                                                                              |
|  11 | Open redirect via login `next` parameter             | Missed           | No delivered case clearly covers the login `next` open redirect.                                                                                                                                                                                                                 |
|  12 | Ineffective login rate limiting                      | Found            | `Rate Limiting Bypass via Spoofed X-Forwarded-For Header` and related login-throttling hardening reached final delivery.                                                                                                                                                         |
|  13 | Race condition in balance updates                    | Missed at repair | Balance and top-up consistency cases did not produce an effective final delivery.                                                                                                                                                                                                |
|  14 | Sensitive data exposure (reviews API + stack traces) | Found            | Review stack-trace exposure and full user-object exposure reached final delivery.                                                                                                                                                                                                |
|  15 | Command injection in admin export                    | Found            | The delivered admin export filename case replaced shell execution with argument-based execution and also added filename/path validation.                                                                                                                                         |
|  16 | Unrestricted file upload (avatar)                    | Found            | The delivered avatar case added server-side file type and extension checks, filename sanitization, and unique filenames.                                                                                                                                                         |
|  17 | Second-order SQL injection in admin reports          | Missed at repair | SQL injection through stored/user-controlled name and admin reports reached delivery, but manual review did not count it as an effective final repair for the answer-key second-order path.                                                                                      |
|  18 | Directory listing / log file disclosure              | Found            | Log/admin access and path-related log disclosure cases reached final delivery, though some broader arbitrary listing cases were blocked.                                                                                                                                         |
|  19 | XXE in XML import                                    | Found            | `XML External Entity (XXE) Injection via Custom Entity Resolution` reached final delivery.                                                                                                                                                                                       |

Using final repair-plan coverage against the ground truth: 13 / 19 answer-key items were covered or partially covered, with 9 complete, 4 incomplete, and 6 missed.

## Discovery and Triage Results

Discovery and triage surfaced most benchmark themes, including SQL injection, JWT `alg:none`, path traversal, review deletion IDOR, plaintext password storage, stored XSS, rate-limit bypass, sensitive data exposure, and XXE. The important weakness appears after delivery: many relevant cases reached final artifacts, but several artifacts were too narrow or ineffective to count as complete answer-key repairs.

### Extra Cases Outside Ground Truth

The run also produced useful non-answer-key or hardening findings, including:

- admin role checks on log/import/export-style endpoints
- JWT and user data stored in `localStorage`
- SQLite database path disclosure in logs
- password complexity and password-confirmation validation defects
- floating-point monetary storage
- GitHub Actions and shared-secret hardening cases

These cases increase review load. Some are valid security-hardening surfaces, while others are lower-priority defects compared with the answer-key vulnerabilities that failed to reach delivery.

Manual review classified three delivered observations as non-security, frontend-only, or product-defect review load for this benchmark: password matching checked only client-side, missing `reviewId` type validation without an authorization impact, and floating-point monetary storage. These cases are excluded from reviewed precision.

| Reviewed precision component                                 | Count |
| ------------------------------------------------------------ | ----: |
| Reviewed true positives                                      |    70 |
| Reviewed false positives                                     |     0 |
| Excluded non-security / frontend-only / product observations |     3 |

### Suppression Behavior

Triage and analyzer judgment reduced 75 cases to 74 confirmed cases and 73 delivered cases. The retained set was permissive: useful hardening cases proceeded alongside lower-priority defects and three findings later treated as non-security, frontend-only, or product-defect review load by manual review.

## Analyzer Judgment Results

Analyzer judgment is the vulnerability-confirmation layer. In this run, the per-case analyzer artifacts show 74 confirmed cases and 1 no-actionable finding.

| Analyzer outcome       | Count |
| ---------------------- | ----: |
| Confirmed risk         |    66 |
| Confirmed defect       |     8 |
| No actionable findings |     1 |

The analyzer confirmed many true issues, but confirmation and delivery did not reliably translate into effective answer-key repairs. The main residual gaps include weak JWT secret coverage, order-history IDOR, CSRF/profile-update coverage, mass assignment, checkout manipulation, second-order SQL injection, and reflected XSS.

## Delivery Results And Evaluation

Book Shop defines 9 ideal deliveries in [book_shop/vulnerabilities_report.md](https://github.com/Agent-AI-Chalmers/book_shop/blob/answer/vulnerabilities_report.md); this run produced 44 actual deliveries.

| Delivery metric    | Count |
| ------------------ | ----: |
| Ideal deliveries   |     9 |
| Actual deliveries  |    44 |
| Delivery count gap |   +35 |

The delivery count gap is much larger, which reflects the 44 delivery artifacts produced by the patch synthesis. The main remaining issue is not under-delivery; it is how many distinct deliveries the run needed to realize the final repair set.

The useful final deliveries cover path traversal, plaintext password storage, stored XSS, JWT `alg:none`, rate-limit bypass, sensitive data exposure, admin export command injection, avatar upload hardening, log disclosure, and XXE. The missing repair coverage is concentrated in checkout/order integrity, profile authorization, reflected XSS, open redirect, balance race handling, and second-order SQL.

## CVSS and Prioritization

The CVSS v4 stage produced severity labels for 74 confirmed cases. The remaining retained case, `d68be87b8cd145`, was a no-actionable workflow-dispatch finding with no severity label and did not reach delivery.

| Critical | High | Medium | Low | None |
| -------: | ---: | -----: | --: | ---: |
|       14 |   23 |     36 |   0 |    1 |

The severity distribution is directionally plausible: direct exploit paths such as SQL injection, command injection, path traversal, JWT bypass, stored XSS, XXE, and sensitive-data exposure are concentrated in the critical and high buckets, while narrower validation and hardening cases mostly fall to medium. The important evaluation caveat is that prioritization did not reliably carry through to complete remediation. Several severe delivered cases were too narrow to count as effective answer-key repairs, and several material answer-key gaps remained after delivery, including checkout/order integrity, profile authorization and mass assignment, reflected XSS, open redirect, balance race handling, and second-order SQL injection.

## Token and Cost Summary

Cost is estimated with the built-in `doubao-seed-2.0-lite` USD price profile.

```bash
python -m scripts.token_usage.summarize .agent-workspace/bookshop-repo-scan-Doubao-Seed-2.0-lite/local-run-20260505T185514Z-252339bb
```

| Scope    | Input tokens | Output tokens | Cache-read tokens | Uncached input tokens | Estimated cost |
| -------- | -----------: | ------------: | ----------------: | --------------------: | -------------: |
| Full run |   51,699,829 |       705,490 |        26,916,600 |            24,783,229 |      $3.088899 |

The stage table reports aggregate usage across all agent calls in each stage, not per-call or per-case averages.

| Stage             | Total input tokens | Total output tokens | Total cache-read tokens | Estimated stage cost (USD) |
| ----------------- | -----------------: | ------------------: | ----------------------: | -------------------------: |
| Discovery         |            303,857 |              25,885 |                  21,040 |                  $0.039551 |
| Triage            |             78,214 |              10,889 |                       0 |                  $0.012810 |
| Triage refiner    |             18,974 |               1,142 |                       0 |                  $0.002313 |
| Analysis          |         10,768,387 |             107,228 |               2,345,584 |                  $0.857104 |
| CVSS v4 scoring   |          1,448,005 |              82,783 |                       0 |                  $0.174195 |
| Mitigation        |         25,669,562 |             274,289 |              17,092,592 |                  $1.224967 |
| Verification      |          8,630,592 |             135,312 |               4,899,064 |                  $0.495736 |
| Delivery planning |            156,788 |              13,673 |                       0 |                  $0.021358 |
| Patch synthesis   |          4,625,450 |              54,289 |               2,558,320 |                  $0.260865 |

## Remaining Gaps

The main remaining gap is delivery conversion. The run found or partially found many benchmark vulnerabilities, but failed to deliver patches for several of them. The most important missed final repairs are checkout price validation, profile mass assignment, reflected XSS, login open redirect, balance race handling, and second-order SQL injection in admin reports.
