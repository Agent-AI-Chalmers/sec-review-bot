# WorldPress Repository Full Scan: Doubao Seed 2.0 Lite

## Scope

This report compares the repository scan workflow output for the WorldPress benchmark against the manually injected ground truth in [worldpress/VULNERABILITIES.md](https://github.com/Agent-AI-Chalmers/worldpress/blob/answer/VULNERABILITIES.md).

- Target repository: `worldpress` main workspace
- Ground truth: [worldpress/VULNERABILITIES.md](https://github.com/Agent-AI-Chalmers/worldpress/blob/answer/VULNERABILITIES.md)
- Model configuration: `anthropic/doubao-seed-2.0-lite`
- Run identifier: `local-run-20260506T094923Z-caa6f3d0`
- Run date: 2026-05-06

Metric definitions follow [Repository Full-Scan Evaluation Concepts](../README.md).

---

```bash
screen -S worldpress-Doubao-Seed-2.0-lite

# cd sec-review-bot

source .venv/bin/activate

sec-review-agents-run-local-repository \
  --repo worldpress \
  --target-branch main \
  --output-dir .agent-workspace/worldpress-repo-scan-Doubao-Seed-2.0-lite
```

These counts describe how the muti-stage workflow behaved internally. They are diagnostic rather than main evaluation metrics.

**The Number Story (End-to-End):** 31 files traversed -> 31 scanned -discovery-> 60 candidates -triage-> 33 cases -analyzer-> 33 confirmed cases -mitigate & verifier-> 33 delivered cases -delivery-> 10 deliveries (7 combined + 3 single).

WorldPress lists 21 numbered answer-key vulnerabilities. The benchmark also names `#11b` as an unauthenticated preview-path traversal subcase; this report shows it separately in the mapping table, but counts it as part of the path-traversal item `#11` for the 21-item denominator.

## Evaluation Summary

| Discovery and triage           | Result                                        |
| ------------------------------ | --------------------------------------------- |
| Benchmark recall at case level | 17 / 21 answer-key items became cases (81.0%) |
| Candidate and case volume      | 60 candidates, 33 cases                       |

| Analyzer judgment                  | Result                                     |
| ---------------------------------- | ------------------------------------------ |
| Benchmark recall at analyzer level | 17 / 21 answer-key items confirmed (81.0%) |
| Confirmed cases                    | 33                                         |

| Remediation                                 | Result                                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Benchmark recall at final repair-plan level | 17 / 21 answer-key items covered (81.0%)                                                      |
| Remediation outcome                         | 17 / 21 complete, 4 missed                                                                    |
| Delivered cases                             | 33 cases across 10 deliveries                                                                 |
| Non-delivered cases                         | 0 cases                                                                                       |
| Delivery quality                            | 10 ideal deliveries, 10 actual deliveries, delivery count gap 0                               |
| Residual repair risks                       | missed weak JWT secret, user-read IDOR, user-profile mass assignment, and login rate limiting |

| Manual review of final cases                | Result                                                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Clear answer-key misses                     | missing login rate limiting, weak JWT secret, user-read IDOR, user-profile mass assignment                                   |
| Confirmed but not delivered answer-key item | none                                                                                                                         |
| Reviewed case precision                     | TP / (TP + FP) = 27 / (27 + 0) = 100.0%                                                                                      |
| False discovery rate                        | FP / (TP + FP) = 0 / (27 + 0) = 0.0%                                                                                         |
| Extra cases after manual review             | 10 additional true-positive or hardening surfaces, 5 non-security/frontend-only/product observations excluded from precision |

Estimated run cost: $1.216244.

Doubao produced the most compact delivery set and matched the 10 ideal-delivery count exactly, but it missed four answer-key items: login rate limiting, weak JWT secret, user-read IDOR, and user-profile mass assignment. It found several additional non-answer-key surfaces, including JWT `alg:none`, weak MD5 password hashing, Flask debug mode, permissive CORS, media deletion authorization, comment posting controls, settings allowlist hardening, and CI hardening. Manual review also found several frontend-only or escaped-rendering claims that should not be counted as effective vulnerabilities.

## Benchmark Recall Against the Answer Key

|   # | Answer-key vulnerability               | Coverage | Evidence from run artifacts                                                                                              |
| --: | -------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
|   1 | SQL injection (login)                  | Found    | `eccfb33ca027aa`: SQL injection via f-string concatenation of username input.                                            |
|   2 | Open redirect                          | Found    | `e916b6affd02f7`: Open redirect via unvalidated redirect parameter.                                                      |
|   3 | Missing login rate limiting            | Missed   | No retained case covers brute-force throttling on `POST /api/auth/login`.                                                |
|   4 | Weak JWT secret                        | Missed   | The run found JWT `alg:none` (`a330679cf89128`) but no case clearly covers the hardcoded weak JWT secret in `config.py`. |
|   5 | IDOR user read                         | Missed   | No retained case clearly covers cross-user `GET /api/users/{id}` access.                                                 |
|   6 | Mass assignment / privilege escalation | Missed   | No retained case clearly covers the user-profile role/mass-assignment path.                                              |
|   7 | Password hash exposure                 | Found    | `1c99c994c263c6`: MD5 password hashes exposed through user APIs.                                                         |
|   8 | SQL injection (search)                 | Found    | `09e5daa5836bc8`: SQL injection via search/filter/category/status parameters.                                            |
|   9 | Stored XSS in post content             | Found    | `630a758c2ea0bf`: Missing XSS sanitization for post content.                                                             |
|  10 | IDOR post edit/delete                  | Found    | `8711500616123f`: Missing ownership/access-control checks for post modification/deletion.                                |
|  11 | Path traversal download                | Found    | `b6bd3a42f7c9f4`: Path traversal in download endpoint.                                                                   |
| 11b | Path traversal preview                 | Found    | `4e2b07734f62ec`: Unauthenticated path traversal in preview endpoint.                                                    |
|  12 | Unrestricted file upload               | Found    | `fc45db29619dcf`: Unrestricted file upload with missing validation.                                                      |
|  13 | Command injection                      | Found    | `595ebbed9fd3bd`: Command injection in thumbnail generation.                                                             |
|  14 | SSRF                                   | Found    | `3736d093594a2a`: SSRF via user-supplied URL.                                                                            |
|  15 | Hardcoded credential leakage           | Found    | `893798905d8bb1`: hard-coded default admin credentials with multiple exposures.                                          |
|  16 | Insecure deserialization               | Found    | `bf800e9624bf95`: insecure base64 pickle import.                                                                         |
|  17 | XXE                                    | Found    | `9f3142cce4f8f2`: XXE in settings import.                                                                                |
|  18 | Full stack trace exposure              | Found    | `c8f2213724d83a`: full exception stack traces exposed to clients.                                                        |
|  19 | Header-based admin bypass              | Found    | `f5a3eff1e13da0`: X-Admin-Override authorization bypass in settings operations.                                          |
|  20 | Stored XSS in comments                 | Found    | `ba6c518e82713c`: Missing XSS sanitization for comment content.                                                          |
|  21 | Reflected XSS in comment author        | Found    | `c28d8e26bb54f4`: Reflected XSS in comment error response.                                                               |

## Discovery and Triage Results

The run scanned all 31 scannable files and produced 60 candidates. Triage retained 33 cases and suppressed 8 candidates. All retained cases reached analyzer completion and all 33 proceeded to delivery.

The most important discovery misses were login rate limiting, the hardcoded weak JWT secret, user-read IDOR, and user-profile role/mass-assignment.

### Extra Cases Outside Ground Truth

Manual review classified 27 cases as true positives and 5 cases as non-security/frontend-only/product observations excluded from reviewed precision. The 27 true positives are the 17 represented answer-key security surfaces plus the 10 additional true-risk or hardening surfaces below.

| Reviewed precision component                                 | Count |
| ------------------------------------------------------------ | ----: |
| Answer-key security surfaces represented                     |    17 |
| Additional true-positive or hardening surfaces               |    10 |
| Reviewed true positives                                      |    27 |
| Reviewed false positives                                     |     0 |
| Excluded non-security / frontend-only / product observations |     5 |

Representative additional cases outside the answer key:

- `a330679cf89128`: JWT `none` algorithm acceptance.
- `41aad77b3b7d46`: Flask debug mode enabled.
- `2e23110cf5117d`: Overly permissive CORS policy.
- `18eef0ce0d4304`: Missing authorization check for media deletion.
- `4a3df462785709`: Unauthenticated comment posting without authentication or rate limiting.
- `6e08a276157b5a`: Manual workflow dispatch without ref restrictions for CodeQL.

Excluded non-security/frontend-only/product observations are cases that are not counted as security true positives or false positives for reviewed precision:

- `0f0820e5a01ca6`: the Dashboard dynamic icon names come from a local static `stats` array, not attacker-controlled data.
- `3b8d078404e096`: the route/path text is rendered through Vue interpolation/breadcrumb text, not `v-html`.
- `581a83bf5068e3`: fetched remote response bodies are displayed in `<pre>{{ fetchResult.body }}</pre>`, so Vue escapes them rather than executing HTML.
- `64d4c69f0f4458` and `eb497d8ca40020`: frontend menu/dashboard visibility is a UX gate, not a standalone authorization boundary; backend authorization issues are covered separately where present.

### Suppression Behavior

Triage suppressed 8 candidates. The final artifact does not need those suppressed candidates for answer-key coverage calculation, but the suppression count is included in the review-load accounting. The retained set was still permissive enough that several frontend-only or escaped-rendering observations proceeded to delivery.

## Analyzer Judgment Results

Analyzer judgment is the vulnerability-confirmation layer: it decides whether cases should proceed as real security cases. All 33 retained cases have structured analyzer judgments.

| Analyzer outcome       | Count |
| ---------------------- | ----: |
| Confirmed risk         |    28 |
| Confirmed defect       |     5 |
| No actionable findings |     0 |

The analyzer was permissive in this run: every retained case proceeded to mitigation and delivery, including the five cases later treated as non-security/frontend-only/product review load by manual review.

## Delivery Results And Evaluation

The patch synthesis processed 10 publishable deliveries: 7 combined deliveries and 3 single-case deliveries. Compared with the 10 ideal delivery groups in [worldpress/VULNERABILITIES.md](https://github.com/Agent-AI-Chalmers/worldpress/blob/answer/VULNERABILITIES.md), the delivery count gap is `0`.

| Delivery metric    | Count |
| ------------------ | ----: |
| Ideal deliveries   |    10 |
| Actual deliveries  |    10 |
| Delivery count gap |     0 |

The zero delivery-count gap does not mean perfect coverage. It means the retained cases were grouped compactly. The answer-key misses above are still material, especially user authorization/mass-assignment and weak JWT-secret coverage.

## CVSS and Prioritization

The CVSS v4 stage scored 33 cases.

| Critical | High | Medium | Low | None |
| -------: | ---: | -----: | --: | ---: |
|        8 |   10 |     15 |   0 |    0 |

Average base score was 7.44, and the maximum base score was 9.9.

## Token and Cost Summary

Cost is estimated with the built-in Doubao Seed 2.0 Lite USD price profile.

```bash
python -m scripts.token_usage.summarize .agent-workspace/worldpress-repo-scan-Doubao-Seed-2.0-lite/local-run-20260506T094923Z-caa6f3d0
```

| Scope    | Input tokens | Output tokens | Cache-read tokens | Uncached input tokens | Estimated cost |
| -------- | -----------: | ------------: | ----------------: | --------------------: | -------------: |
| Full run |   18,849,504 |       303,553 |         8,904,088 |             9,945,416 |      $1.216244 |

The stage table reports aggregate usage across all agent calls in each stage, not per-call or per-case averages.

| Stage             | Total input tokens | Total output tokens | Total cache-read tokens | Estimated stage cost (USD) |
| ----------------- | -----------------: | ------------------: | ----------------------: | -------------------------: |
| Discovery         |            110,744 |              15,883 |                   1,848 |                  $0.018252 |
| Triage            |             44,893 |               6,386 |                       0 |                  $0.007425 |
| Triage refiner    |             30,769 |               4,159 |                       0 |                  $0.004973 |
| Analysis          |          3,945,933 |              45,647 |                 578,912 |                  $0.337645 |
| CVSS v4 scoring   |            651,340 |              32,437 |                   9,840 |                  $0.075104 |
| Mitigation        |          9,222,059 |             102,842 |               5,768,960 |                  $0.469126 |
| Verification      |          3,277,287 |              59,809 |               1,521,256 |                  $0.217124 |
| Delivery planning |             42,140 |               2,898 |                       0 |                  $0.005329 |
| Patch synthesis   |          1,524,339 |              33,492 |               1,023,272 |                  $0.081266 |

## Remaining Gaps

### Missing Authorization and Account Controls

The run missed the user-read IDOR and user-profile role/mass-assignment path. It found post ownership and settings/admin authorization issues, but did not fully enumerate user-account authorization boundaries.

### JWT Coverage

The run found JWT `alg:none`, but missed the hardcoded weak JWT secret in `config.py`.

### Missing Login Rate Limiting

No retained case covers brute-force throttling on `POST /api/auth/login`. This remains the shared absent-control miss across all WorldPress reports.
