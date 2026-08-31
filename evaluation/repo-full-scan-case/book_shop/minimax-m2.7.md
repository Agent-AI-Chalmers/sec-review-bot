# Book Shop Repository Full Scan: MiniMax M2.7

## Scope

This report compares the repository scan workflow output for the Book Shop benchmark against the manually injected ground truth in [book_shop/vulnerabilities_report.md](https://github.com/Agent-AI-Chalmers/book_shop/blob/answer/vulnerabilities_report.md).

- Target repository: `book_shop` main workspace
- Ground truth: [book_shop/vulnerabilities_report.md](https://github.com/Agent-AI-Chalmers/book_shop/blob/answer/vulnerabilities_report.md)
- Model configuration: `anthropic/minimax-m2.7` for all repository stages
- Run identifier: `local-run-20260507T025947Z-24f53633`
- Run date: 2026-05-07

Metric definitions follow [Repository Full-Scan Evaluation Concepts](../README.md).

---

```bash
screen -S bookshop-minimax27

# cd sec-review-bot

source .venv/bin/activate

sec-review-agents-run-local-repository \
  --repo book_shop \
  --target-branch main \
  --output-dir .agent-workspace/bookshop-repo-scan-minimax27
```

---

These counts describe how the multi-stage workflow behaved internally. They are diagnostic rather than main evaluation metrics.

**The Number Story (End-to-End):** 71 cases -analyzer-> 61 confirmed cases (+ 10 rejected) -mitigate & verifier-> 61 delivered cases -delivery-> 53 deliveries (5 combined + 48 single).

## Evaluation Summary

| Discovery and triage           | Result                                        |
| ------------------------------ | --------------------------------------------- |
| Benchmark recall at case level | 17 / 19 answer-key items became cases (89.5%) |
| Candidate and case volume      | 136 candidates, 71 cases                      |

| Analyzer judgment                  | Result                                     |
| ---------------------------------- | ------------------------------------------ |
| Benchmark recall at analyzer level | 17 / 19 answer-key items confirmed (89.5%) |
| Confirmed cases                    | 61                                         |

| Remediation                                 | Result                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Benchmark recall at final repair-plan level | 17 / 19 answer-key items covered or partially covered (89.5%)                                                             |
| Remediation outcome                         | 16 complete, 1 incomplete, 2 missed                                                                                       |
| Delivered cases                             | 61 cases across 53 deliveries                                                                                             |
| Non-delivered cases                         | 10 analyzer-rejected or no-patch cases                                                                                    |
| Delivery quality                            | 9 ideal deliveries, 53 actual deliveries, delivery count gap +44                                                          |
| Residual repair risks                       | very fragmented delivery set, incomplete ownership coverage, missing CSRF/profile-update control, missed second-order SQL |

| Manual review of final cases                | Result                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Clear answer-key miss                       | CSRF via cookie-authenticated profile update; second-order SQL injection in admin reports                   |
| Confirmed but not delivered answer-key item | none identified after analyzer filtering                                                                    |
| Reviewed case precision                     | TP / (TP + FP) = 57 / (57 + 0) = 100.0%                                                                     |
| False discovery rate                        | FP / (TP + FP) = 0 / (57 + 0) = 0.0%                                                                        |
| Extra cases after manual review             | many additional true or hardening surfaces, including workflow, logging, admin-auth, and localStorage risks |

Estimated run cost: $8.280616.

MiniMax M2.7 had broad detection and delivered many patches, but the delivery set is much more fragmented than the ideal Book Shop repair plan.

## Benchmark Recall Against the Answer Key

The Book Shop answer key has 19 numbered sections. This report maps lettered sub-items to their parent sections.

|   # | Ground-truth vulnerability                           | Workflow result | Evidence / case                                                                                                                                                                                         |
| --: | ---------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | SQL injection (search/login/register)                | Found           | Delivered cases covered `$queryRawUnsafe`, login SQL injection, and search SQL injection.                                                                                                               |
|   2 | JWT bypass (alg:none + weak secret)                  | Found           | `a69d122af431f2` removed the hardcoded `secret123` fallback and the `alg:none` bypass in `src/lib/jwt.ts`.                                                                                              |
|   3 | Path traversal in `/api/assets?file=`                | Found           | `Path traversal in assets route allows arbitrary file read` reached final delivery.                                                                                                                     |
|   4 | IDOR (order history + review deletion)               | Incomplete      | Order-history IDOR was delivered. The answer-key review-deletion ownership path is not clearly covered as a final repair.                                                                               |
|   5 | Client-controlled checkout total / price tampering   | Found           | `Client-supplied total not validated against item prices` reached final delivery.                                                                                                                       |
|   6 | Plaintext password storage                           | Found           | `Plaintext password storage without hashing` and login plaintext-password handling reached final delivery.                                                                                              |
|   7 | Stored XSS in reviews                                | Found           | `Stored XSS via innerHTML rendering of user review content` reached final delivery.                                                                                                                     |
|   8 | Reflected XSS in search query                        | Found           | `Cross-Site Scripting via Unescaped Query Parameter` reached final delivery.                                                                                                                            |
|   9 | Profile mass assignment / privilege escalation       | Found           | `PATCH allows arbitrary field updates via mass assignment` reached final delivery.                                                                                                                      |
|  10 | CSRF via cookie-authenticated profile update         | Missed          | The only explicit CSRF case was a newsletter-form case rejected as no actionable finding. Session-cookie hardening helps adjacent auth risk but does not cover the answer-key profile-update CSRF path. |
|  11 | Open redirect via login `next` parameter             | Found           | `Unvalidated open redirect via 'next' query parameter` reached final delivery.                                                                                                                          |
|  12 | Ineffective login rate limiting                      | Found           | `Rate limiting bypassable via spoofed IP headers` reached final delivery.                                                                                                                               |
|  13 | Race condition in balance updates                    | Found           | Balance deduction and top-up TOCTOU cases reached final delivery.                                                                                                                                       |
|  14 | Sensitive data exposure (reviews API + stack traces) | Found           | Full user-object exposure, sensitive profile fields, and stack-trace disclosure cases reached final delivery.                                                                                           |
|  15 | Command injection in admin export                    | Found           | `Command injection via filename parameter` and related export filename cases reached final delivery.                                                                                                    |
|  16 | Unrestricted file upload (avatar)                    | Found           | Avatar upload file type, size, and filename hardening cases reached final delivery.                                                                                                                     |
|  17 | Second-order SQL injection in admin reports          | Missed          | Delivered SQL injection cases covered register, login, and search query construction. No final case clearly covered the admin reports second-order SQL path.                                            |
|  18 | Directory listing / log file disclosure              | Found           | Admin log path traversal and log disclosure cases reached final delivery.                                                                                                                               |
|  19 | XXE in XML import                                    | Found           | XXE, path traversal through entity parsing, and XML upload validation cases reached final delivery.                                                                                                     |

Using final repair-plan coverage against the ground truth: 17 / 19 answer-key items were covered or partially covered, with 16 complete, 1 incomplete, and 2 missed.

## Discovery and Triage Results

Discovery and triage were broad. The run found nearly every answer-key class and many additional defects in workflow security, logging, admin authorization, localStorage persistence, schema validation, and input validation. The cost of this breadth is review load: many findings are valid but adjacent to, duplicative of, or lower priority than the benchmark vulnerabilities.

### Extra Cases Outside Ground Truth

Representative additional or hardening cases include:

- GitHub workflow scanning bypass and mutable action tags
- HMAC signatures written to workflow output
- localStorage token, user, and cart persistence risks
- admin authorization checks on import/export/log endpoints
- internal filesystem path and PII logging
- password strength and schema-level validation gaps
- numeric range validation for price and stock fields

These cases should be separated from answer-key recall. They are useful context, but they also explain why the delivered case count is much higher than the benchmark vulnerability count.

Manual review classified four delivered observations as non-security, frontend-only, or product-defect review load for this benchmark: URL-length/sensitive-data filtering for the search box, seed ID uniqueness in `prisma/seed.ts`, hardcoded profile-form defaults, and client-side-only profile field validation. These cases are excluded from reviewed precision.

| Reviewed precision component                                 | Count |
| ------------------------------------------------------------ | ----: |
| Reviewed true positives                                      |    57 |
| Reviewed false positives                                     |     0 |
| Excluded non-security / frontend-only / product observations |     4 |

### Suppression Behavior

Triage and analyzer judgment reduced 71 cases to 61 confirmed cases. The rejected or no-actionable set mostly contains client-side-only observations, non-authoritative validation claims, and findings without a concrete server-side security boundary.

## Analyzer Judgment Results

Analyzer judgment is the vulnerability-confirmation layer. In this run, 61 / 71 cases were confirmed and 10 were rejected.

| Analyzer outcome       | Count |
| ---------------------- | ----: |
| Confirmed risk         |    49 |
| Confirmed defect       |    12 |
| No actionable findings |    10 |

The analyzer confirmed most retained cases. The rejected set includes several client-side or non-authoritative observations, such as profile modification concerns without a concrete server-side bypass, a newsletter CSRF case, and UI-only avatar rendering concerns.

## Delivery Results And Evaluation

Book Shop defines 9 ideal deliveries in [book_shop/vulnerabilities_report.md](https://github.com/Agent-AI-Chalmers/book_shop/blob/answer/vulnerabilities_report.md); this run produced 53 actual deliveries.

| Delivery metric    | Count |
| ------------------ | ----: |
| Ideal deliveries   |     9 |
| Actual deliveries  |    53 |
| Delivery count gap |   +44 |

The `+44` gap comes from heavy fragmentation. Only 5 deliveries combined multiple cases, while 48 deliveries were single-case artifacts. SQL injection, auth/session hardening, file/path handling, admin authorization, data exposure, and XML import hardening are all spread across many separate deliveries.

The run is therefore strong on finding and patching individual surfaces, but weak on packaging them into reviewer-friendly repair groups. A reviewer would need to reassemble many single-case patches into the 9 intended Book Shop delivery boundaries.

## CVSS and Prioritization

The CVSS v4 stage scored 61 cases.

| Critical | High | Medium | Low | None |
| -------: | ---: | -----: | --: | ---: |
|        6 |   25 |     22 |   0 |    8 |

The scorer ranked the most direct exploit paths, such as SQL injection, command injection, path traversal, and XXE, near the top. Several workflow and hardening cases received `none`, which is reasonable when application exploitability is indirect.

## Token and Cost Summary

Cost is estimated with the built-in `minimax-m2.7` USD price profile.

```bash
python -m scripts.token_usage.summarize .agent-workspace/bookshop-repo-scan-minimax27/local-run-20260507T025947Z-24f53633
```

| Scope    | Input tokens | Output tokens | Cache-read tokens | Uncached input tokens | Estimated cost |
| -------- | -----------: | ------------: | ----------------: | --------------------: | -------------: |
| Full run |   23,974,168 |       906,971 |                 0 |            23,974,168 |      $8.280616 |

The stage table reports aggregate usage across all agent calls in each stage, not per-call or per-case averages.

| Stage             | Total input tokens | Total output tokens | Total cache-read tokens | Estimated stage cost (USD) |
| ----------------- | -----------------: | ------------------: | ----------------------: | -------------------------: |
| Discovery         |            253,453 |              68,877 |                       0 |                  $0.158688 |
| Triage            |             79,678 |              25,112 |                       0 |                  $0.054038 |
| Triage refiner    |             16,259 |               4,703 |                       0 |                  $0.010521 |
| Analysis          |          7,627,117 |             219,727 |                       0 |                  $2.551807 |
| CVSS v4 scoring   |            890,294 |             141,435 |                       0 |                  $0.436810 |
| Mitigation        |          9,512,108 |             193,858 |                       0 |                  $3.086262 |
| Verification      |          4,820,712 |             224,950 |                       0 |                  $1.716154 |
| Delivery planning |            370,430 |              10,447 |                       0 |                  $0.123665 |
| Patch synthesis   |            404,117 |              17,862 |                       0 |                  $0.142670 |

## Remaining Gaps

The clearest answer-key gaps are CSRF on cookie-authenticated profile updates and second-order SQL injection in admin reports. Ownership hardening is only partially covered: the final repair clearly covers order history but not the review-deletion path. The main reviewability gap is delivery fragmentation: 53 artifacts for a 9-delivery ideal plan.
