# Raddit Repository Full Scan: mimo-v2.5-pro

## Scope

This report compares the repository scan workflow output for the Raddit benchmark against the manually injected ground truth in [raddit/VULNERABILITIES.md](https://github.com/Agent-AI-Chalmers/raddit/blob/answer/VULNERABILITIES.md).

- Target repository: `raddit` main workspace
- Ground truth: [raddit/VULNERABILITIES.md](https://github.com/Agent-AI-Chalmers/raddit/blob/answer/VULNERABILITIES.md)
- Model configuration: `anthropic/mimo-v2.5-pro` for all repository stages
- Run identifier: `local-run-20260501T134557Z-bbb2ee06`
- Run date: 2026-05-01

Metric definitions follow [Repository Full-Scan Evaluation Concepts](../README.md).

---

```bash
screen -S raddit-mimo-v2.5-pro

# cd sec-review-bot

source .venv/bin/activate

sec-review-agents-run-local-repository \
  --repo raddit \
  --target-branch main \
  --output-dir .agent-workspace/raddit-repo-scan-mimo-v2.5-pro
```

These counts describe how the muti-stage workflow behaved internally. They are diagnostic rather than main evaluation metrics.

**The Number Story (End-to-End):** 39 files traversed -> 39 scanned -discovery-> 87 candidates -triage-> 45 cases -analyzer-> 35 confirmed cases (+ 3 plausible-risk, 7 rejected) -mitigate & verifier-> 34 verified cases -delivery-> 14 deliveries (7 combined + 7 single).

## Evaluation Summary

| Discovery and triage           | Result                                        |
| ------------------------------ | --------------------------------------------- |
| Benchmark recall at case level | 21 / 22 answer-key items became cases (95.5%) |
| Candidate and case volume      | 87 candidates, 45 cases                       |

| Analyzer judgment                  | Result                                     |
| ---------------------------------- | ------------------------------------------ |
| Benchmark recall at analyzer level | 21 / 22 answer-key items confirmed (95.5%) |
| Confirmed cases                    | 35                                         |

| Remediation                                 | Result                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Benchmark recall at final repair-plan level | 21 / 22 answer-key items covered (95.5%)                                                  |
| Remediation outcome                         | 21 / 22 complete, 1 missed (login rate limiting)                                          |
| Delivered cases                             | 34 cases across 14 deliveries                                                             |
| Non-delivered cases                         | 7 analyzer-rejected, 3 plausible-risk without patch, 1 verifier-rejected confirmed defect |
| Delivery quality                            | 9 ideal deliveries, 14 actual deliveries, delivery count gap +5                           |
| Residual repair risks                       | dependency lockfiles, deployment docs/config for required secrets and secure cookies      |

| Manual review of final cases                | Result                                                            |
| ------------------------------------------- | ----------------------------------------------------------------- |
| Clear answer-key miss                       | login rate limiting was not discovered                            |
| Confirmed but not delivered answer-key item | none                                                              |
| Reviewed case precision                     | TP / (TP + FP) = 29 / (29 + 0) = 100.0%                           |
| False discovery rate                        | FP / (TP + FP) = 0 / (29 + 0) = 0.0%                              |
| Extra cases after manual review             | 8 additional true positives, 5 duplicate cases, 0 false positives |

Estimated run cost: $10.691960.

These numbers indicate that the workflow converted nearly all answer-key vulnerabilities into cases, confirmed them through analysis, and repaired them, with the same single miss at each level: login rate limiting. Manual review found no false positives among non-duplicate final cases, and the final repairs are mostly complete, with remaining concerns concentrated in operational hardening rather than unresolved answer-key vulnerabilities.

## Benchmark Recall Against the Answer Key

|   # | Ground-truth vulnerability                           | Workflow result | Evidence / case                                                                                                                                                                                                                   |
| --: | ---------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | SQL injection in `POST /api/auth/login`              | Found           | `c3f68a7a4560eb` fixed the login SQL query via parameterization.                                                                                                                                                                  |
|   2 | SQL injection in `GET /api/posts/search?q=`          | Found           | `1b16b76c6a9ee6` covered `SearchPosts` and merged with `b4ecebdf2418bc`, which also fixed `ListPosts`.                                                                                                                            |
|   3 | SQL injection in `GET /api/posts?sort=&order=`       | Found           | `b4ecebdf2418bc` fixed `ListPosts` by parameterizing `subreddit` and allowlisting `sort` / `order`.                                                                                                                               |
|   4 | Path traversal in file download                      | Found           | `ef55a5dd5a4c1a` covered unsanitized `name` in `DownloadFile`.                                                                                                                                                                    |
|   5 | Arbitrary file upload                                | Found           | `11d5f45d631911` added upload type / extension validation. Related upload hardening was merged with path and size checks.                                                                                                         |
|   6 | Command injection in ping tool                       | Found           | `31536b05121271` fixed command injection in unauthenticated ping/nslookup endpoints.                                                                                                                                              |
|   7 | SSRF in URL preview                                  | Found           | `3ae79423377dfa` added URL validation and private-IP blocking for `PreviewURL`.                                                                                                                                                   |
|   8 | IDOR delete post                                     | Found           | `fbfeccc56b1ca1` added server-side ownership authorization to `DeletePost`; `b3faff02857a7c` was merged as an overlapping frontend/server authorization case.                                                                     |
|   9 | Password hash exposure in user response              | Found           | `693d7bb879a73f` removed password hash serialization from API responses and admin UI.                                                                                                                                             |
|  10 | User-controllable role privilege escalation          | Found           | `3824ffdfeb291c` removed the user-controllable role field from profile updates.                                                                                                                                                   |
|  11 | Weak JWT secret                                      | Found           | `299e282beeb622` covered hardcoded default secrets, including the JWT signing key.                                                                                                                                                |
|  12 | JWT `alg:none` bypass                                | Found           | `7399bde9b24771` fixed signature skipping for `alg:none`.                                                                                                                                                                         |
|  13 | Admin debug information disclosure                   | Found           | `6a7a8b2886386d` covered `SystemInfo` secret exposure.                                                                                                                                                                            |
|  14 | Hardcoded admin credentials                          | Found           | `299e282beeb622` covered hardcoded default admin credentials.                                                                                                                                                                     |
|  15 | Plaintext password logging on failed login           | Found           | `6af10dc141d935` removed plaintext password logging in failed login paths.                                                                                                                                                        |
|  16 | Missing rate limiting on login                       | Missed          | No discovery candidate or triage case directly matched login brute-force / rate limiting.                                                                                                                                         |
|  17 | Open redirect in login                               | Found           | `ca1f207946ddac` validated login redirect destinations.                                                                                                                                                                           |
|  18 | Stored XSS in post content                           | Found           | `0d2f2e0ffe62eb` covered raw post content rendering.                                                                                                                                                                              |
|  19 | Stored XSS in comment content                        | Found           | `2828f0ede43cec` covered raw comment content rendering.                                                                                                                                                                           |
|  20 | Reflected XSS in search query                        | Found           | `a2b83242e5cf65` covered `dangerouslySetInnerHTML` with URL search input.                                                                                                                                                         |
|  21 | Stored XSS in profile bio                            | Found           | `d89ba179a80f4f` covered raw profile bio rendering.                                                                                                                                                                               |
|  22 | Missing CSRF protection for state-changing endpoints | Found           | `2d85143d3c13a5` covered the state-changing logout-via-GET CSRF case. `9a1e4982b4939a` confirmed broader cookie-authenticated state-changing request CSRF and added Origin/Referer validation for cookie-authenticated mutations. |

Using binary benchmark recall against the ground truth: 21 / 22 found, 1 / 22 missed.

The only missed answer-key item is #16, missing login rate limiting.

## Discovery and Triage Results

Discovery and triage are evaluated as scanner-like output: they provide security leads for later stages, comparable in role to Semgrep, CodeQL, ZAP, or other tools that surface candidate alerts. This run shows high discovery recall for concrete code-level vulnerabilities, but weaker coverage for absent cross-cutting controls.

Discovery produced 87 candidates, and triage converted 45 of them into cases while suppressing 19 lower-confidence candidates. The case set included precise issues for SQL injection, XSS, path traversal, unsafe upload/download handling, command injection, SSRF, IDOR, JWT flaws, hardcoded credentials, sensitive-data exposure, and redirect/CSRF issues. The SearchPosts SQL injection case `1b16b76c6a9ee6` is a useful example: it was discovered, triaged, and later merged into the same delivery as the related `ListPosts` SQL injection fix.

The main discovery miss was login rate limiting. No candidate directly matched brute-force protection or login throttling. That is a discovery-stage false negative. The likely reason is structural: missing rate limiting is a negative control across route behavior, while the discovery prompts were more effective at identifying localized sinks such as SQL string concatenation, raw HTML rendering, shell execution, and path joins.

Triage behavior was mostly conservative in the right direction. It suppressed client-side-only observations when the backend was the true security boundary, React-rendered text where escaping prevented XSS, and generic supply-chain observations without a concrete exploit path. The tradeoff is that broad missing-control classes can be missed unless the workflow asks explicitly for them.

### Extra Cases Outside Ground Truth

The workflow produced 13 cases outside the answer-key list. Manual review found 8 valid additional cases, 5 duplicate cases, and 0 false positives.

For reviewed case precision, manual review classified 29 cases as true positives and 0 cases as false positives. The 29 true positives are the 21 represented answer-key security surfaces plus the 8 additional security surfaces below. Duplicate cases are excluded from the precision denominator, following the README definition.

| Reviewed precision component               | Count |
| ------------------------------------------ | ----: |
| Answer-key security surfaces represented   |    21 |
| Additional true-positive security surfaces |     8 |
| Reviewed true positives                    |    29 |
| Reviewed false positives                   |     0 |

| Case             | Claim                                                                  | Manual review | Reason                                                                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2463faf832f965` | `golang.org/x/net` pinned to a version affected by HTTP/2 Rapid Reset. | Valid         | `go.mod` pins `golang.org/x/net v0.16.0`. The default app runs plain HTTP, so direct exploitability is deployment-dependent, but the vulnerable dependency is real.                                                       |
| `2a38cdd3d06cc7` | Admin handlers lack in-file authentication or authorization guards.    | Duplicate     | The original auth-guard claim is misleading because admin routes use auth middleware. The final patch fixes `SystemInfo` secret exposure, which is already answer-key item #13.                                           |
| `4719040bf517d1` | JWT token stored in `localStorage`, increasing XSS impact.             | Valid         | The frontend stores bearer tokens in `localStorage` while the benchmark also contains XSS sinks. This is not a standalone answer-key item, but it materially increases XSS impact.                                        |
| `47dd2b7b202bfe` | Upload path traversal via unsanitized original filename.               | Valid         | `UploadFile` joins `config.UploadDir` with attacker-controlled `header.Filename`, allowing writes outside the upload directory. This is distinct from download path traversal.                                            |
| `6f338e9531da59` | Admin credentials logged in plaintext during seeding.                  | Duplicate     | The answer-key hardcoded-admin-credentials item explicitly includes the seed-time log line that prints `admin / admin123`.                                                                                                |
| `886a25d5e5a55c` | Race condition in vote check-then-act flow.                            | Valid         | `VotePost` performs SELECT then INSERT/UPDATE without a transaction and ignores write errors. The impact is lower because of the unique constraint and SQLite serialization, but the integrity defect is real.            |
| `9682456c71d345` | JWT role claim trusted without server-side verification.               | Duplicate     | The final fix is merged with the role-escalation delivery and reinforces answer-key items #10 and #12 by rejecting forged JWT roles, removing user-controlled role updates, and checking admin role against the database. |
| `b3faff02857a7c` | Client-side-only authorization gate for post edit and delete actions.  | Duplicate     | The final fix contributes to server-side delete authorization, which is already covered by answer-key item #8.                                                                                                            |
| `b31ec12d00f5f9` | Session cookie missing `Secure` flag.                                  | Valid         | Login/logout set the JWT cookie with `Secure=false` unconditionally, so production HTTP transport can expose the session token.                                                                                           |
| `dacfd69ff1aefd` | No file upload size limit.                                             | Valid         | `UploadFile` copies the request body to disk without enforcing `config.MaxUploadSize`, enabling authenticated disk-exhaustion denial of service.                                                                          |
| `de7402e201298e` | File download endpoint accessible without authentication.              | Valid         | `/api/files/download` is registered without `AuthRequired`, and `r.Static("/uploads", ...)` also exposes uploaded files outside the authenticated API path.                                                               |
| `e960b94ca0035c` | Unvalidated redirect destination returned to client in logout.         | Valid         | Logout accepts and returns a caller-controlled redirect destination. This is a separate auth-flow redirect issue from the answer-key login redirect.                                                                      |
| `fa266532e4badd` | Weak and bypassable HTML sanitization.                                 | Duplicate     | The final fix is part of the XSS repair group and is already represented by the answer-key XSS items.                                                                                                                     |

Using the README definitions, reviewed case precision is `TP / (TP + FP) = 29 / (29 + 0) = 100.0%`, and false discovery rate is `FP / (TP + FP) = 0 / (29 + 0) = 0.0%`. Duplicate cases are excluded from both denominators.

### Suppression Behavior

Triage suppressed 19 candidates. The suppressions were mostly low-confidence or non-authoritative client-side observations, for example:

- client-side API wrappers without guards, where the backend is the real security boundary
- React-rendered API error messages where React text escaping prevents XSS
- client-side form validation gaps without a concrete server-side sink
- generic dependency or supply-chain observations without a specific exploit path
- observations subsumed by stronger cases, such as password strength for a hardcoded seeded admin password

This suppression pattern is mostly desirable for false-positive control. The main risk is that “missing control” classes, especially rate limiting, can be under-prioritized unless discovery explicitly searches for them.

## Analyzer Judgment Results

Analyzer judgment is the vulnerability-confirmation layer: it decides whether cases should proceed as real security cases. In this run, all 45 cases have structured analyzer judgments.

| Analyzer outcome            | Count |
| --------------------------- | ----: |
| Confirmed vulnerability     |    31 |
| Confirmed repository defect |     4 |
| Plausible risk              |     3 |
| No actionable hypothesis    |     7 |

Discovery and triage provide leads, but they do not have to fully prove the vulnerability. Analyzer judgment is where those leads are checked against the repository's actual control flow and trust boundaries. The broader CSRF case `9a1e4982b4939a` is a useful example: the lead pointed at cookie-based authentication without visible CSRF protection, and the analyzer then connected the middleware token extraction, state-changing routes, browser cookie behavior, and missing Origin/Referer validation into a confirmed multi-file vulnerability.

The cases had strong manual-review quality after duplicate removal: answer-key matches plus additional true positives produced 29 true positives and 0 reviewed false positives. The analyzer-stage weakness was not over-admission of invalid cases; the remaining risk is that broad or evidence-sensitive controls need enough structured evidence to survive into remediation.

## Delivery Results And Evaluation

Raddit defines 9 ideal deliveries in [raddit/VULNERABILITIES.md](https://github.com/Agent-AI-Chalmers/raddit/blob/answer/VULNERABILITIES.md); this run produced 14 actual deliveries.

| Delivery metric    | Count |
| ------------------ | ----: |
| Ideal deliveries   |     9 |
| Actual deliveries  |    14 |
| Delivery count gap |    +5 |

The `+5` gap mainly comes from repairs being split more finely than the ideal delivery plan.

- Authentication abuse controls were spread across separate login SQL injection, password logging, redirect, and missing-rate-limit outcomes.
- Server-side outbound interaction safety was split between command execution and SSRF fixes.
- User authorization and profile data controls were split across ownership, user serialization, and role-hardening deliveries.
- Some actual deliveries also bundled adjacent but distinct ideal deliveries, such as credential/JWT/default hardening with admin debug exposure and session-cookie hardening.

## CVSS and Prioritization

The CVSS v4 stage scored 38 cases.

| Critical | High | Medium | Low | None |
| -------: | ---: | -----: | --: | ---: |
|        8 |   21 |      7 |   0 |    2 |

Scoring quality is mostly good. The severe implementation bugs are ranked near the top: unauthenticated SQL injection, command injection, JWT forgery, and hardcoded credential chains are scored critical. Lower-impact or more conditional issues, such as logout CSRF and open redirects, are scored medium.

Two cases were scored as `0.0 / none`: the vote race condition and logout redirect response. In both cases, the scorer found a plausible defect but not enough evidence that the current code path produces a concrete CVSS confidentiality, integrity, or availability impact.

## Token and Cost Summary

Cost is estimated with the built-in `mimo-v2.5-pro` USD price profile. The official overseas model price for inputs up to 256K tokens is $1.00 per 1M uncached input tokens, $0.20 per 1M cached input tokens, and $3.00 per 1M output tokens. The 256K-1M tier is $2.00, $0.40, and $6.00 per 1M tokens respectively; this run falls into the <=256K tier by average input size per agent call.

```bash
python -m scripts.token_usage.summarize .agent-workspace/raddit-repo-scan-mimo-v2.5-pro/local-run-20260501T134557Z-bbb2ee06
```

| Scope    | Input tokens | Output tokens | Cache-read tokens | Uncached input tokens | Estimated cost |
| -------- | -----------: | ------------: | ----------------: | --------------------: | -------------: |
| Full run |   30,813,829 |       867,631 |        28,405,952 |             2,407,877 |     $10.691960 |

The stage table reports aggregate usage across all agent calls in each stage, not per-call or per-case averages.

| Stage             | Total input tokens | Total output tokens | Total cache-read tokens | Estimated stage cost (USD) |
| ----------------- | -----------------: | ------------------: | ----------------------: | -------------------------: |
| Discovery         |            173,103 |              48,516 |                  76,928 |                  $0.257109 |
| Triage            |             57,705 |              28,216 |                  15,168 |                  $0.130219 |
| Triage refiner    |             14,902 |              12,484 |                       0 |                  $0.052354 |
| Analysis          |         12,961,644 |             287,568 |              12,244,096 |                  $4.029071 |
| CVSS v4 scoring   |          1,779,222 |             120,864 |               1,481,536 |                  $0.956585 |
| Mitigation        |          8,843,428 |             127,916 |               8,351,424 |                  $2.546037 |
| Verification      |          4,325,286 |             181,377 |               3,769,152 |                  $1.854095 |
| Delivery planning |            290,532 |              20,426 |                 261,760 |                  $0.142402 |
| Patch synthesis   |          2,368,007 |              40,264 |               2,205,888 |                  $0.724089 |

## Remaining Gaps

### #16 Missing Login Rate Limiting

No matching discovery candidate was found for rate limiting or brute-force protection. This is the clearest false negative in the run.

Likely reason: missing rate limiting is a negative control across route behavior, not a localized dangerous sink. The discovery grounding logic favors candidates with concrete locations and snippets. SQL concatenation, raw HTML rendering, command execution, and unsafe file paths all have obvious evidence snippets; the absence of rate limiting requires broader architectural reasoning across middleware and route registration.
