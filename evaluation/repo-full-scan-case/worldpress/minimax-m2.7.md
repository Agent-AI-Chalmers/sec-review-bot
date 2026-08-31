# WorldPress Repository Full Scan: MiniMax M2.7

## Scope

This report compares the repository scan workflow output for the WorldPress benchmark against the manually injected ground truth in [worldpress/VULNERABILITIES.md](https://github.com/Agent-AI-Chalmers/worldpress/blob/answer/VULNERABILITIES.md).

- Target repository: `worldpress` main workspace
- Ground truth: [worldpress/VULNERABILITIES.md](https://github.com/Agent-AI-Chalmers/worldpress/blob/answer/VULNERABILITIES.md)
- Model configuration: `anthropic/minimax-m2.7` for all repository stages
- Run identifier: `local-run-20260506T121631Z-5e446d7c`
- Run date: 2026-05-06

Metric definitions follow [Repository Full-Scan Evaluation Concepts](../README.md).

---

```bash
screen -S worldpress-minimax27

# cd sec-review-bot

source .venv/bin/activate

sec-review-agents-run-local-repository \
  --repo worldpress \
  --target-branch main \
  --output-dir .agent-workspace/worldpress-repo-scan-minimax27
```

---

These counts describe how the muti-stage workflow behaved internally. They are diagnostic rather than main evaluation metrics.

**The Number Story (End-to-End):** 31 files traversed -> 31 scanned -discovery-> 94 candidates -triage-> 52 cases -analyzer-> 49 confirmed cases (+ 3 no-actionable) -mitigate & verifier-> 49 delivered cases -delivery-> 49 deliveries (0 combined + 49 single).

WorldPress lists 21 numbered answer-key vulnerabilities. The benchmark also names `#11b` as an unauthenticated preview-path traversal subcase; this report shows it separately in the mapping table, but counts it as part of the path-traversal item `#11` for the 21-item denominator.

## Evaluation Summary

| Discovery and triage           | Result                                        |
| ------------------------------ | --------------------------------------------- |
| Benchmark recall at case level | 20 / 21 answer-key items became cases (95.2%) |
| Candidate and case volume      | 94 candidates, 52 cases                       |

| Analyzer judgment                  | Result                                     |
| ---------------------------------- | ------------------------------------------ |
| Benchmark recall at analyzer level | 20 / 21 answer-key items confirmed (95.2%) |
| Confirmed cases                    | 49                                         |

| Remediation                                 | Result                                                            |
| ------------------------------------------- | ----------------------------------------------------------------- |
| Benchmark recall at final repair-plan level | 20 / 21 answer-key items covered (95.2%)                          |
| Remediation outcome                         | 20 / 21 complete, 1 missed                                        |
| Delivered cases                             | 49 cases across 49 deliveries                                     |
| Non-delivered cases                         | 3 blocked before delivery planning                                |
| Delivery quality                            | 10 ideal deliveries, 49 actual deliveries, delivery count gap +39 |
| Residual repair risks                       | login rate limiting was not discovered; no delivery consolidation |

| Manual review of final cases                | Result                                                                                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clear answer-key miss                       | login rate limiting was not discovered                                                                                                                         |
| Confirmed but not delivered answer-key item | none                                                                                                                                                           |
| Reviewed case precision                     | TP / (TP + FP) = 30 / (30 + 0) = 100.0%                                                                                                                        |
| False discovery rate                        | FP / (TP + FP) = 0 / (30 + 0) = 0.0%                                                                                                                           |
| Extra cases after manual review             | 10 additional true-positive or hardening surfaces, many duplicate/overlapping cases, 7 non-security/frontend-only/product observations excluded from precision |

Observed run cost from provider-reported token usage: $6.277521. Cache-adjusted estimate using the mimo-v2.5-pro observed cache ratio: $2.317299.

The only answer-key miss is #3, missing login rate limiting. The run found many additional hardening or duplicate surfaces, but it emitted every publishable case as a separate delivery, creating the largest delivery-count gap among the three WorldPress runs. Manual review found several delivered frontend-only, weak validation, or data-model observations that should be counted as review load rather than effective vulnerabilities.

## Benchmark Recall Against the Answer Key

|   # | Answer-key vulnerability               | Coverage | Evidence from run artifacts                                                                                            |
| --: | -------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
|   1 | SQL injection (login)                  | Found    | `b04df6952a5587`: SQL injection via string-interpolated query; `406d00550d455e`: SQL injection via request parameters. |
|   2 | Open redirect                          | Found    | `8e97c7f9ee5987`: Open redirect via query parameter and server-controlled redirect.                                    |
|   3 | Missing login rate limiting            | Missed   | No retained case covers brute-force throttling on `POST /api/auth/login`.                                              |
|   4 | Weak JWT secret                        | Found    | `62ca10593658e0`: Hardcoded application signing secret.                                                                |
|   5 | IDOR user read                         | Found    | `052556c62f5474`: IDOR allows cross-user profile access.                                                               |
|   6 | Mass assignment / privilege escalation | Found    | `1785bdf4d50607`: Mass assignment allows unauthorized field modification.                                              |
|   7 | Password hash exposure                 | Found    | `e1556480e41784`: Password hashes exposed in API responses.                                                            |
|   8 | SQL injection (search)                 | Found    | `406d00550d455e` and `b04df6952a5587`: SQL injection cases covering request-parameter SQL construction.                |
|   9 | Stored XSS in post content             | Found    | `d882246e88e191` and `67b45221e99089`: stored XSS via HTML-enabled post/content fields.                                |
|  10 | IDOR post edit/delete                  | Found    | `3c1af19961ee3a` and `8ed502650f838a`: missing ownership checks on post modification/deletion.                         |
|  11 | Path traversal download                | Found    | `54d9c007734958`: Path traversal in `/download`.                                                                       |
| 11b | Path traversal preview                 | Found    | `7021d07d2f74ee`: Path traversal in unauthenticated `/preview`.                                                        |
|  12 | Unrestricted file upload               | Found    | `6c6e94190944d5`: no extension/content validation.                                                                     |
|  13 | Command injection                      | Found    | `e5b2e48133118a`: command injection in thumbnail generation.                                                           |
|  14 | SSRF                                   | Found    | `81db7582dbc138` and `cf5fefa5aedca0`: unrestricted backend URL fetch.                                                 |
|  15 | Hardcoded credential leakage           | Found    | `6f4afda6ddc55c`, `1b8bcfcfe24ef4`, and `db9a630607dc67`: hardcoded/default credentials.                               |
|  16 | Insecure deserialization               | Found    | `e9a8917ac58ff0`: insecure pickle deserialization.                                                                     |
|  17 | XXE                                    | Found    | `e60adf219c07ce`: unsafe lxml parser configuration.                                                                    |
|  18 | Full stack trace exposure              | Found    | `34083f452c4cde`: unhandled exception handler information disclosure.                                                  |
|  19 | Header-based admin bypass              | Found    | `410b01fd56a9da` and `54d97a24f2809a`: X-Admin-Override bypass.                                                        |
|  20 | Stored XSS in comments                 | Found    | `858e85cbb689f1`: stored XSS via v-html comment rendering.                                                             |
|  21 | Reflected XSS in comment author        | Found    | `cb979abd5993f7`: reflected XSS via author parameter.                                                                  |

## Discovery and Triage Results

The run scanned all 31 scannable files and produced 94 candidates. Triage retained 52 cases and suppressed 33 candidates. All retained cases reached analyzer completion.

Three cases were blocked before delivery planning because they did not produce applied patches:

- `55c1863ac2a891`: Missing CSRF protection on state-changing requests.
- `68ab1f67d75bc9`: Potential CSRF vulnerability in post save/publish operations.
- `f808ecf7b64b8c`: Unrestricted global component registration from external library.

The two CSRF cases are useful hardening observations, but CSRF is not one of the 21 WorldPress answer-key items.

### Extra Cases Outside Ground Truth

I manually reviewed the 49 delivered cases against the source before treating them as effective findings.

| Reviewed precision component                                 | Count |
| ------------------------------------------------------------ | ----: |
| Answer-key security surfaces represented                     |    20 |
| Additional true-positive or hardening surfaces               |    10 |
| Reviewed true positives                                      |    30 |
| Reviewed false positives                                     |     0 |
| Excluded non-security / frontend-only / product observations |     7 |

| Review bucket                                                            | Count |
| ------------------------------------------------------------------------ | ----: |
| Delivered cases covering answer-key items, including duplicates/subcases |    32 |
| Delivered additional true-risk or hardening surfaces outside answer key  |    10 |
| Delivered non-security / frontend-only / product observations            |     7 |
| Blocked cases not counted as delivered coverage                          |     3 |

Manual excluded review-load calls:

- `4b3313c45bb6e1`, `ce4ceb7e6851cf`, and `d0a9b33b6650b0`: frontend state, localStorage, or route-gating observations are not standalone backend authorization vulnerabilities.
- `b683bf2c7cff60`: user-profile over-disclosure is weak as a security finding without a cross-user access path; the actual IDOR is counted separately.
- `db48c27ff62509`: anonymous comments lacking a user association is a product/data-model weakness, not one of the benchmark security vulnerabilities.
- `dcd0cc95deaa65`: generic registration input validation is not tied to an exploitable sink in the delivered evidence.
- `ee551c1cb57508`: client-side-only upload validation is not a security boundary; the real server-side unrestricted upload is already counted under `#12`.

Manual true-risk/hardening examples outside the answer key include debug mode, JWT `alg:none`, weak MD5/password storage, token persistence in `localStorage`, media deletion authorization, dependency integrity hardening, and dependency installation hardening.

### Suppression Behavior

Triage suppressed 33 candidates. The retained set was broad and still included many duplicate, frontend-only, or product-model observations, while the absent login-rate-limiting control was not retained as a case.

## Analyzer Judgment Results

Analyzer judgment is the vulnerability-confirmation layer: it decides whether cases should proceed as real security cases. All 52 retained cases have structured analyzer judgments.

| Analyzer outcome       | Count |
| ---------------------- | ----: |
| Confirmed risk         |    39 |
| Confirmed defect       |    10 |
| No actionable findings |     3 |

The three no-actionable cases were blocked before delivery planning and are excluded from delivered coverage.

## Delivery Results And Evaluation

The patch synthesis processed 49 publishable deliveries: 0 combined deliveries and 49 single-case deliveries. Compared with the 10 ideal delivery groups in [worldpress/VULNERABILITIES.md](https://github.com/Agent-AI-Chalmers/worldpress/blob/answer/VULNERABILITIES.md), the delivery count gap is `+39`.

| Delivery metric    | Count |
| ------------------ | ----: |
| Ideal deliveries   |    10 |
| Actual deliveries  |    49 |
| Delivery count gap |   +39 |

This run has broad answer-key coverage but weak delivery synthesis. Related repairs that should normally be reviewed together were left as separate artifacts, including SQL query safety, user authorization and mass assignment, media path/upload/command handling, settings parser safety, hardcoded credential/JWT hardening, and XSS rendering controls.

## CVSS and Prioritization

The CVSS v4 stage scored 49 cases.

| Critical | High | Medium | Low | None |
| -------: | ---: | -----: | --: | ---: |
|       16 |   21 |     10 |   0 |    2 |

Average base score was 7.84, and the maximum base score was 9.9.

## Token and Cost Summary

Cost is estimated with the built-in `minimax-m2.7` USD price profile.

```bash
python -m scripts.token_usage.summarize .agent-workspace/worldpress-repo-scan-minimax27/local-run-20260506T121631Z-5e446d7c
```

| Scope    | Input tokens | Output tokens | Cache-read tokens | Uncached input tokens | Estimated cost |
| -------- | -----------: | ------------: | ----------------: | --------------------: | -------------: |
| Full run |   18,099,730 |       706,335 |                 0 |            18,099,730 |      $6.277521 |

The observed run artifacts report `0` cache-read tokens. For cross-run comparison, a cache-adjusted estimate is also reported by applying the mimo-v2.5-pro observed cache ratio to the MiniMax input volume:

```text
mimo cache ratio = 19,768,000 / 21,683,361 = 91.166678%
estimated MiniMax cache-read tokens = 18,099,730 * 91.166678% = 16,500,923
estimated MiniMax uncached input tokens = 1,598,807
cache-adjusted MiniMax cost = $2.317299
```

The stage table reports aggregate usage across all agent calls in each stage, not per-call or per-case averages.

| Stage             | Total input tokens | Total output tokens | Total cache-read tokens | Estimated stage cost (USD) |
| ----------------- | -----------------: | ------------------: | ----------------------: | -------------------------: |
| Discovery         |             88,889 |              30,787 |                       0 |                  $0.063611 |
| Triage            |             43,122 |              13,299 |                       0 |                  $0.028895 |
| Triage refiner    |             14,557 |               5,013 |                       0 |                  $0.010383 |
| Analysis          |          4,650,899 |             145,404 |                       0 |                  $1.569754 |
| CVSS v4 scoring   |            771,726 |             110,746 |                       0 |                  $0.364413 |
| Mitigation        |          7,345,238 |             175,873 |                       0 |                  $2.414619 |
| Verification      |          4,944,324 |             184,797 |                       0 |                  $1.705054 |
| Delivery planning |            240,975 |              40,416 |                       0 |                  $0.120792 |

## Remaining Gaps

### Missing Login Rate Limiting

No matching discovery candidate was retained for login brute-force protection or rate limiting. This is the only answer-key miss in the run.

### Delivery Integration

All 49 final deliveries are single deliveries. The run therefore demonstrates broad case-by-case mitigation, but not integrated delivery planning for overlapping fixes.
