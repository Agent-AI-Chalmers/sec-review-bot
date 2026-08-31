# WorldPress Repository Full Scan: mimo-v2.5-pro

## Scope

This report compares the repository scan workflow output for the WorldPress benchmark against the manually injected ground truth in [worldpress/VULNERABILITIES.md](https://github.com/Agent-AI-Chalmers/worldpress/blob/answer/VULNERABILITIES.md).

- Target repository: `worldpress` main workspace
- Ground truth: [worldpress/VULNERABILITIES.md](https://github.com/Agent-AI-Chalmers/worldpress/blob/answer/VULNERABILITIES.md)
- Model configuration: `anthropic/mimo-v2.5-pro` for all repository stages
- Run identifier: `local-run-20260505T230542Z-7dc4e75a`
- Run date: 2026-05-05

Metric definitions follow [Repository Full-Scan Evaluation Concepts](../README.md).

---

```bash
screen -S worldpress-mimo-v2.5-pro

# cd sec-review-bot

source .venv/bin/activate

sec-review-agents-run-local-repository \
  --repo worldpress \
  --target-branch main \
  --output-dir .agent-workspace/worldpress-repo-scan-mimo-v2.5-pro
```

---

These counts describe how the muti-stage workflow behaved internally. They are diagnostic rather than main evaluation metrics.

**The Number Story (End-to-End):** 31 files traversed -> 31 scanned -discovery-> 85 candidates -triage-> 39 cases -analyzer-> 36 confirmed cases (+ 3 no-actionable) -mitigate & verifier-> 36 delivered cases -delivery-> 20 deliveries (9 combined + 11 single).

WorldPress lists 21 numbered answer-key vulnerabilities. The benchmark also names `#11b` as an unauthenticated preview-path traversal subcase; this report shows it separately in the mapping table, but counts it as part of the path-traversal item `#11` for the 21-item denominator.

## Evaluation Summary

| Discovery and triage           | Result                                        |
| ------------------------------ | --------------------------------------------- |
| Benchmark recall at case level | 20 / 21 answer-key items became cases (95.2%) |
| Candidate and case volume      | 85 candidates, 39 cases                       |

| Analyzer judgment                  | Result                                     |
| ---------------------------------- | ------------------------------------------ |
| Benchmark recall at analyzer level | 20 / 21 answer-key items confirmed (95.2%) |
| Confirmed cases                    | 36                                         |

| Remediation                                 | Result                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| Benchmark recall at final repair-plan level | 20 / 21 answer-key items covered (95.2%)                                    |
| Remediation outcome                         | 20 / 21 complete, 1 missed                                                  |
| Delivered cases                             | 36 cases across 20 deliveries                                               |
| Non-delivered cases                         | 3 blocked before delivery planning                                          |
| Delivery quality                            | 10 ideal deliveries, 20 actual deliveries, delivery count gap +10           |
| Residual repair risks                       | login rate limiting was not discovered; some delivery fragmentation remains |

| Manual review of final cases                | Result                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Clear answer-key miss                       | login rate limiting was not discovered                                                                          |
| Confirmed but not delivered answer-key item | none                                                                                                            |
| Reviewed case precision                     | TP / (TP + FP) = 33 / (33 + 0) = 100.0%                                                                         |
| False discovery rate                        | FP / (TP + FP) = 0 / (33 + 0) = 0.0%                                                                            |
| Extra cases after manual review             | 13 additional true-positive or hardening surfaces, 1 duplicate/non-answer-key lead, 0 delivered false positives |

Estimated run cost: $8.891914.

The only answer-key miss is #3, missing login rate limiting. The run also produced additional security and hardening cases outside the answer key, including JWT `alg:none`, token storage in `localStorage`, wildcard CORS, Flask debug mode, weak MD5 password hashing, media deletion ownership, comment creation hardening, settings-write hardening, subprocess error leakage, mutable GitHub Actions pins, and client-side authorization observations. Manual review treats the client-side-only blocked cases as review-load context, not delivered security coverage.

## Benchmark Recall Against the Answer Key

|   # | Answer-key vulnerability               | Coverage | Evidence from run artifacts                                                              |
| --: | -------------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
|   1 | SQL injection (login)                  | Found    | `7a3dcf3c9114a6`: SQL Injection via username in login query.                             |
|   2 | Open redirect                          | Found    | `5f9f2f349001c2`: Open redirect via unvalidated login redirect parameter.                |
|   3 | Missing login rate limiting            | Missed   | No retained case covers brute-force throttling on `POST /api/auth/login`.                |
|   4 | Weak JWT secret                        | Found    | `ad440b80ef4562`: Hardcoded application signing secret.                                  |
|   5 | IDOR user read                         | Found    | `c78d03534b3525`: IDOR on user profile retrieval.                                        |
|   6 | Mass assignment / privilege escalation | Found    | `561e037ba935b4`: Privilege escalation via role field in user update forms.              |
|   7 | Password hash exposure                 | Found    | `b4b6c4478b169a`: Password hashes exposed in list/profile/CSV export.                    |
|   8 | SQL injection (search)                 | Found    | `a6d4fe7f9515bd`: SQL Injection via search/category/status query parameters.             |
|   9 | Stored XSS in post content             | Found    | `8cbf1b8b551bc3`: Stored XSS via unsanitized post content.                               |
|  10 | IDOR post edit/delete                  | Found    | `3b1dfb8317cd29` and `7e746092586cd7`: delete/update post IDOR.                          |
|  11 | Path traversal download                | Found    | `03f4202771b97c`: Path traversal in media download and preview endpoints.                |
| 11b | Path traversal preview                 | Found    | Covered by `03f4202771b97c` as the preview subpath of #11.                               |
|  12 | Unrestricted file upload               | Found    | `a4149429c865e8`: Unrestricted file upload allows executable file types.                 |
|  13 | Command injection                      | Found    | `5eb888f3b65b24`: shell=True command injection in thumbnail generation.                  |
|  14 | SSRF                                   | Found    | `fdb15c1c92884a`: SSRF via `/fetch-url`.                                                 |
|  15 | Hardcoded credential leakage           | Found    | `60eff98e40be26`: hardcoded default credentials exposed via config/API/stdout/seed data. |
|  16 | Insecure deserialization               | Found    | `e61be6a24f9050`: insecure pickle deserialization.                                       |
|  17 | XXE                                    | Found    | `d533e483f545c8`: XXE injection in XML import.                                           |
|  18 | Full stack trace exposure              | Found    | `a56aba22855d1`: full stack trace returned to client.                                    |
|  19 | Header-based admin bypass              | Found    | `ecd411e11d2783`: X-Admin-Override admin authorization bypass.                           |
|  20 | Stored XSS in comments                 | Found    | `399a4ef1bcb7fd` and `b87e5fe833d447`: comment-content XSS.                              |
|  21 | Reflected XSS in comment author        | Found    | `e6096fdde846ff`: reflected XSS via author field in comment error response.              |

## Discovery and Triage Results

The run scanned all 31 scannable files and produced 85 candidates. Triage retained 39 cases and suppressed 26 candidates. All retained cases reached analyzer completion.

Three cases were blocked before delivery planning because they did not produce applied patches:

- `18acd6828627be`: Mass assignment via `Object.assign` from API response into form.
- `c04b8bf7958ed7`: Admin-level API calls without client-side role gating.
- `efdc9afd22235b`: Client-side-only auth guard bypassable without server-side enforcement.

Manual review treats these blocked cases as review-load context rather than final delivered security coverage.

### Extra Cases Outside Ground Truth

I manually reviewed the 36 delivered cases against the source before summarizing precision. This run had no clear delivered false-positive in the same sense as the escaped-rendering/frontend-only Doubao cases, but it did include duplicate or hardening findings that should not inflate answer-key coverage.

| Reviewed precision component                   | Count |
| ---------------------------------------------- | ----: |
| Answer-key security surfaces represented       |    20 |
| Additional true-positive or hardening surfaces |    13 |
| Reviewed true positives                        |    33 |
| Reviewed false positives                       |     0 |

| Review bucket                                                            | Count |
| ------------------------------------------------------------------------ | ----: |
| Delivered cases covering answer-key items, including duplicates/subcases |    22 |
| Delivered additional true-risk or hardening surfaces outside answer key  |    13 |
| Delivered duplicate/non-answer-key lead                                  |     1 |
| Blocked cases not counted as delivered coverage                          |     3 |

Manual review notes:

- `b1af0eefb16207` is a valid stored-XSS lead but overlaps the same post-content XSS root cause covered by `8cbf1b8b551bc3`, so it is counted as duplicate review load.
- `171079fed90249`, `387232486a306f`, `af44146e1fd900`, `b65fa69f2af368`, `8524882e7cad04`, `c32a5526c41453`, `cab023d6462890`, `e3006638c89337`, `eeeedf206a0cd6`, and similar cases are treated as extra true-risk or hardening surfaces, not answer-key recall.
- Blocked cases `18acd6828627be`, `c04b8bf7958ed7`, and `efdc9afd22235b` did not produce applied patches and are excluded from delivered coverage.

### Suppression Behavior

Triage suppressed 26 candidates. Suppression mostly reduced lower-confidence or overlapping leads before analyzer judgment, but it did not suppress the key absent-control miss: no retained candidate directly covered login rate limiting.

## Analyzer Judgment Results

Analyzer judgment is the vulnerability-confirmation layer: it decides whether cases should proceed as real security cases. All 39 retained cases have structured analyzer judgments.

| Analyzer outcome       | Count |
| ---------------------- | ----: |
| Confirmed risk         |    33 |
| Confirmed defect       |     3 |
| No actionable findings |     3 |

The three no-actionable cases were blocked before delivery planning and are excluded from delivered coverage.

## Delivery Results And Evaluation

The patch synthesis processed 20 publishable deliveries: 9 combined deliveries and 11 single-case deliveries. Compared with the 10 ideal delivery groups in [worldpress/VULNERABILITIES.md](https://github.com/Agent-AI-Chalmers/worldpress/blob/answer/VULNERABILITIES.md), the delivery count gap is `+10`.

| Delivery metric    | Count |
| ------------------ | ----: |
| Ideal deliveries   |    10 |
| Actual deliveries  |    20 |
| Delivery count gap |   +10 |

The strongest delivery grouping is around related backend themes: content XSS, post ownership, media OS/file handling, settings/admin parser safety, user data controls, error handling, and auth-secret hardening. Remaining fragmentation comes from splitting related auth/session and sensitive-data issues into separate delivery artifacts.

## CVSS and Prioritization

The CVSS v4 stage scored 36 cases.

| Critical | High | Medium | Low | None |
| -------: | ---: | -----: | --: | ---: |
|       10 |   17 |      7 |   1 |    1 |

Average base score was 7.61, and the maximum base score was 9.3.

## Token and Cost Summary

Cost is estimated with the built-in `mimo-v2.5-pro` USD price profile.

```bash
python -m scripts.token_usage.summarize .agent-workspace/worldpress-repo-scan-mimo-v2.5-pro/local-run-20260505T230542Z-7dc4e75a
```

| Scope    | Input tokens | Output tokens | Cache-read tokens | Uncached input tokens | Estimated cost |
| -------- | -----------: | ------------: | ----------------: | --------------------: | -------------: |
| Full run |   21,683,361 |     1,007,651 |        19,768,000 |             1,915,361 |      $8.891914 |

The stage table reports aggregate usage across all agent calls in each stage, not per-call or per-case averages.

| Stage             | Total input tokens | Total output tokens | Total cache-read tokens | Estimated stage cost (USD) |
| ----------------- | -----------------: | ------------------: | ----------------------: | -------------------------: |
| Discovery         |            100,964 |             114,195 |                  31,936 |                  $0.418000 |
| Triage            |             33,792 |              17,344 |                   6,144 |                  $0.080909 |
| Triage refiner    |             12,750 |               4,433 |                       0 |                  $0.026049 |
| Analysis          |          7,274,191 |             258,828 |               6,771,776 |                  $2.633254 |
| CVSS v4 scoring   |          1,342,106 |             119,302 |               1,101,824 |                  $0.818553 |
| Mitigation        |          8,745,918 |             309,808 |               8,209,920 |                  $3.107406 |
| Verification      |          2,949,353 |             140,544 |               2,579,520 |                  $1.307369 |
| Delivery planning |            240,397 |              18,410 |                 193,024 |                  $0.141208 |
| Patch synthesis   |            983,890 |              24,787 |                 873,856 |                  $0.359166 |

## Remaining Gaps

### Missing Login Rate Limiting

No matching discovery candidate was retained for login brute-force protection or rate limiting. This is the only answer-key miss in the run.

### Delivery Fragmentation

The run produced 20 actual deliveries for 10 ideal delivery groups. Related auth/session, user data, and hardening repairs remained split across multiple delivery artifacts.
