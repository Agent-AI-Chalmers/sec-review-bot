# Book Shop Repository Full Scan: mimo-v2.5-pro

## Scope

This report compares the repository scan workflow output for the Book Shop benchmark against the manually injected ground truth in [book_shop/vulnerabilities_report.md](https://github.com/Agent-AI-Chalmers/book_shop/blob/answer/vulnerabilities_report.md).

- Target repository: `book_shop` main workspace
- Ground truth: [book_shop/vulnerabilities_report.md](https://github.com/Agent-AI-Chalmers/book_shop/blob/answer/vulnerabilities_report.md)
- Model configuration: `anthropic/mimo-v2.5-pro` for all repository stages
- Run identifier: `local-run-20260502T175619Z-d577f5d9`
- Run date: 2026-05-02

Metric definitions follow [Repository Full-Scan Evaluation Concepts](../README.md).

---

```bash
screen -S bookshop-mimo-v2.5-pro

# cd sec-review-bot

source .venv/bin/activate

sec-review-agents-run-local-repository \
  --repo book_shop \
  --target-branch main \
  --output-dir .agent-workspace/bookshop-repo-scan-mimo-v2.5-pro
```

---

These counts describe how the multi-stage workflow behaved internally. They are diagnostic rather than main evaluation metrics.

**The Number Story (End-to-End):** 79 files traversed -> 79 scanned -discovery-> 119 candidates -triage-> 42 cases -analyzer-> 40 confirmed cases (+ 2 rejected) -mitigate & verifier-> 39 delivered cases -delivery-> 22 deliveries (10 combined + 12 single).

## Evaluation Summary

| Discovery and triage           | Result                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| Benchmark recall at case level | 19 / 19 answer-key items became cases (100.0%; 18 direct + 1 indirect CSRF/session mapping) |
| Candidate and case volume      | 119 candidates, 42 cases                                                                    |

| Analyzer judgment                  | Result                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| Benchmark recall at analyzer level | 19 / 19 answer-key items confirmed (100.0%; 18 direct + 1 indirect CSRF/session mapping) |
| Confirmed cases                    | 40                                                                                       |

| Remediation                                 | Result                                                                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Benchmark recall at final repair-plan level | 19 / 19 answer-key items covered (100.0%; 18 direct + 1 indirect CSRF/session mapping)                                |
| Remediation outcome                         | 19 / 19 complete                                                                                                      |
| Delivered cases                             | 39 cases across 22 deliveries                                                                                         |
| Non-delivered cases                         | 2 analyzer-rejected, 1 confirmed log-exposure case with unresolved verification                                       |
| Delivery quality                            | 9 ideal deliveries, 22 actual deliveries, delivery count gap +13                                                      |
| Residual repair risks                       | broad combined patch blast radius, session/CSRF semantics, operational handling of required secrets and log artifacts |

| Manual review of final cases                | Result                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Clear answer-key miss                       | none                                                                                              |
| Confirmed but not delivered answer-key item | none                                                                                              |
| Reviewed case precision                     | TP / (TP + FP) = 27 / (27 + 0) = 100.0%                                                           |
| False discovery rate                        | FP / (TP + FP) = 0 / (27 + 0) = 0.0%                                                              |
| Extra cases after manual review             | 8 additional true-positive surfaces, 3 overlapping/duplicate security surfaces, 0 false positives |

Estimated run cost: $9.835646.

The run completed and produced usable end-to-end artifacts. All analyzer calls completed; the remaining non-delivered cases are analyzer rejections or verifier-gated patch coverage, not runtime failures.

## Benchmark Recall Against the Answer Key

The Book Shop answer key has 19 numbered sections. This report maps lettered sub-items to their parent sections.

|   # | Ground-truth vulnerability                           | Workflow result  | Evidence / case                                                                                                                                                                                                |
| --: | ---------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | SQL injection (search/login/register)                | Found            | `c72e706a61755d` covered `$queryRawUnsafe` string interpolation across the search, login, register, and admin-report query paths.                                                                              |
|   2 | JWT bypass (alg:none + weak secret)                  | Found            | `7173d8ba95797f` rejected unsigned `alg:none` tokens; `54865866b2e6ae` removed the hardcoded fallback signing key.                                                                                             |
|   3 | Path traversal in `/api/assets?file=`                | Found            | `64d0b0e656a00c` added path containment to the asset-serving route.                                                                                                                                            |
|   4 | IDOR (order history + review deletion)               | Found            | `6c0fb93b2319eb`, `d9c4d7c021e5b3`, and `d101929c91ed97` covered user-controlled `userId` and missing ownership checks.                                                                                        |
|   5 | Client-controlled checkout total / price tampering   | Found            | `00defd430055ba`, `15b7a77f57caaf`, and `f1efe39129065e` covered server-side price validation and transactionality.                                                                                            |
|   6 | Plaintext password storage                           | Found            | `25e21000a7cbcf` covered plaintext password storage/comparison; `67c1bb674a81eb` covered hardcoded dummy passwords.                                                                                            |
|   7 | Stored XSS in reviews                                | Found            | `2290c8f5f44c81` covered unsafe review `innerHTML` rendering.                                                                                                                                                  |
|   8 | Reflected XSS in search query                        | Found            | `17b87a071fe167` covered `dangerouslySetInnerHTML` with the `q` parameter.                                                                                                                                     |
|   9 | Profile mass assignment / privilege escalation       | Found            | `a5c25da61ae999` replaced unfiltered PATCH body spreading with an allowlist.                                                                                                                                   |
|  10 | CSRF via cookie-authenticated profile update         | Found indirectly | `356671ca13b7a8` and `31cbc59fed5538` hardened session cookies and moved clients away from script-readable token storage. The run did not produce a case explicitly titled as CSRF-token or Origin validation. |
|  11 | Open redirect via login `next` parameter             | Found            | `644f36d4d4d00f` validated the login redirect destination.                                                                                                                                                     |
|  12 | Ineffective login rate limiting                      | Found            | `381beb8137c07a` replaced spoofable IP-header keyed throttling with an email-based key.                                                                                                                        |
|  13 | Race condition in balance updates                    | Found            | `74c2918e577632` covered the non-atomic read-modify-write balance flow.                                                                                                                                        |
|  14 | Sensitive data exposure (reviews API + stack traces) | Found            | `51a18757610dcc` minimized review user data; `1a23466c8611d0`, `692ff9af4d0bd6`, and `f744c33794cdb8` covered stack-trace/log exposure.                                                                        |
|  15 | Command injection in admin export                    | Found            | `c63b5092880143` covered attacker-controlled filename reaching shell execution.                                                                                                                                |
|  16 | Unrestricted file upload (avatar)                    | Found            | `0eaf6db85bfb4f`, `9033db385a61ae`, and `90760f344ac351` covered avatar upload hardening gaps.                                                                                                                 |
|  17 | Second-order SQL injection in admin reports          | Found            | `c72e706a61755d` addressed raw SQL string interpolation across admin reports.                                                                                                                                  |
|  18 | Directory listing / log file disclosure              | Found            | `fe02bbc2e68ba9` covered attacker-controlled log paths.                                                                                                                                                        |
|  19 | XXE in XML import                                    | Found            | `c5b55787245171` covered entity expansion/arbitrary file read behavior.                                                                                                                                        |

Using binary benchmark recall against the ground truth: 19 / 19 found, 0 / 19 missed. The CSRF item is counted as covered because the final repair blocks the answer-key cookie-auth cross-site request path with strict session-cookie behavior, but it is an indirect mapping rather than an explicit CSRF-token finding.

## Discovery and Triage Results

Discovery and triage were highly recall-oriented on this benchmark. They retained cases for all answer-key surfaces: SQL injection, JWT verification flaws, path traversal, IDOR, price tampering, plaintext passwords, stored/reflected XSS, mass assignment, CSRF-adjacent session behavior, open redirect, and ineffective rate limiting.

### Extra Cases Outside Ground Truth

Manual review found 11 delivered non-answer-key or overlapping security surfaces: 8 were credited as additional true positives, and 3 were treated as overlapping or duplicate review load. It found 0 false positives among delivered cases. Duplicate and overlapping cases are excluded from the reviewed precision denominator.

Representative additional surfaces include:

- admin export path traversal and shell command execution hardening
- admin logs path traversal
- XML import validation beyond the answer-key XXE behavior
- avatar upload file type, size, and filename hardening
- session cookie `httpOnly` hardening and localStorage token exposure
- JWT payload minimization
- review response minimization
- top-up balance race handling
- sensitive logs and stack traces

Using the README definitions, reviewed case precision is `TP / (TP + FP) = 27 / (27 + 0) = 100.0%`, and false discovery rate is `FP / (TP + FP) = 0 / (27 + 0) = 0.0%`.

| Reviewed precision component               | Count |
| ------------------------------------------ | ----: |
| Answer-key security surfaces represented   |    19 |
| Additional true-positive security surfaces |     8 |
| Reviewed true positives                    |    27 |
| Reviewed false positives                   |     0 |

### Suppression Behavior

Triage and refinement reduced 119 discovery candidates to 42 cases. The suppressed or merged observations were mostly client-side-only leads without a server-side trust-boundary break, generic validation complaints without a concrete dangerous sink, duplicate leads merged into broader cases, and best-practice claims that did not produce a specific exploit path.

Two retained cases were later rejected by analyzer judgment:

- `0b44bf9762ba20`: profile save can be sent without an Authorization header in the client, but the server still rejects unauthenticated PATCH requests.
- `8d938b76e84fe8`: a generic rapid-failed-login observation was rejected in favor of the more precise spoofable-header rate-limiting case `381beb8137c07a`.

## Analyzer Judgment Results

Analyzer judgment is the vulnerability-confirmation layer: it decides whether cases should proceed as real security cases. In this run, 40 / 42 cases were confirmed and 2 were rejected.

| Analyzer outcome       | Count |
| ---------------------- | ----: |
| Confirmed risk         |    40 |
| No actionable findings |     2 |

All 19 answer-key items were represented in confirmed cases. The analyzer was strongest on localized code-level flaws and also correctly validated broader trust-boundary issues such as mass assignment, IDOR, and ineffective rate limiting.

## Delivery Results And Evaluation

Book Shop defines 9 ideal deliveries in [book_shop/vulnerabilities_report.md](https://github.com/Agent-AI-Chalmers/book_shop/blob/answer/vulnerabilities_report.md); this run produced 22 actual deliveries.

| Delivery metric    | Count |
| ------------------ | ----: |
| Ideal deliveries   |     9 |
| Actual deliveries  |    22 |
| Delivery count gap |   +13 |

The `+13` gap mainly comes from repairs being split more finely than the ideal delivery plan.

- Authentication and session controls were split across JWT hardening, password storage, login cookie, rate limiting, open redirect, and localStorage/session deliveries.
- File and path handling was split across asset containment, avatar upload hardening, admin log controls, and admin export file handling.
- Authorization and ownership controls were split across order history, review deletion, and admin-role checks.
- Frontend rendering safety was split between stored review XSS and reflected search XSS.
- Sensitive data exposure fixes were spread across review response minimization, stack traces, logs, JWT payloads, and committed log artifacts.

The actual delivery set is reviewable and complete for the answer key, but a reviewer still has to reassemble several security themes that the benchmark defines as 9 ideal deliveries.

## CVSS and Prioritization

The CVSS v4 stage scored 40 cases.

| Critical | High | Medium | Low | None |
| -------: | ---: | -----: | --: | ---: |
|        9 |   26 |      4 |   1 |    0 |

Scoring quality is directionally reasonable. Critical findings include SQL injection, JWT forgery, command injection, hardcoded secrets, stored XSS, path traversal writes, and the spoofable login rate limiter. High findings cover most authorization, data exposure, upload, XXE, and business-logic issues.

## Token and Cost Summary

Cost is estimated with the built-in `mimo-v2.5-pro` USD price profile.

```bash
python -m scripts.token_usage.summarize .agent-workspace/bookshop-repo-scan-mimo-v2.5-pro/local-run-20260502T175619Z-d577f5d9
```

| Scope    | Input tokens | Output tokens | Cache-read tokens | Uncached input tokens | Estimated cost |
| -------- | -----------: | ------------: | ----------------: | --------------------: | -------------: |
| Full run |   26,997,095 |       926,591 |        24,926,528 |             2,070,567 |      $9.835646 |

The stage table reports aggregate usage across all agent calls in each stage, not per-call or per-case averages.

| Stage             | Total input tokens | Total output tokens | Total cache-read tokens | Estimated stage cost (USD) |
| ----------------- | -----------------: | ------------------: | ----------------------: | -------------------------: |
| Discovery         |            249,117 |              70,188 |                  89,152 |                  $0.388359 |
| Triage            |             89,952 |              34,127 |                  33,600 |                  $0.165453 |
| Triage refiner    |             19,876 |              12,080 |                       0 |                  $0.056116 |
| Analysis          |          7,365,223 |             165,598 |               6,986,432 |                  $2.272871 |
| CVSS v4 scoring   |          1,199,448 |             217,577 |                 962,688 |                  $1.082029 |
| Mitigation        |         11,734,408 |             168,935 |              11,186,560 |                  $3.291965 |
| Verification      |          3,449,411 |             175,100 |               2,991,168 |                  $1.581777 |
| Delivery planning |            305,223 |              29,325 |                 280,128 |                  $0.169096 |
| Patch synthesis   |          2,584,437 |              53,661 |               2,396,800 |                  $0.827980 |

## Remaining Gaps

No answer-key item was missed. The only confirmed non-delivered case is `1a96ef3fa9ce99`, where verifier coverage remained unresolved for a broad committed access-log exposure claim. Related log cleanup was still delivered through narrower log and error-exposure cases.

The main reviewability gap is delivery organization: the run produced 22 actual deliveries for a 9-delivery ideal plan, so several related repairs need reviewer-side consolidation even though the answer-key vulnerabilities are covered.
