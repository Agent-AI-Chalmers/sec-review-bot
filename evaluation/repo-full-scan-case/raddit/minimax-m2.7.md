# Raddit Repository Full Scan: MiniMax M2.7

## Scope

This report compares the repository scan workflow output for the Raddit benchmark against the manually injected ground truth in [raddit/VULNERABILITIES.md](https://github.com/Agent-AI-Chalmers/raddit/blob/answer/VULNERABILITIES.md).

- Target repository: `raddit` main workspace
- Ground truth: [raddit/VULNERABILITIES.md](https://github.com/Agent-AI-Chalmers/raddit/blob/answer/VULNERABILITIES.md)
- Model configuration: `anthropic/minimax-m2.7` for all repository stages
- Run identifier: `local-run-20260502T003113Z-1a68e255`
- Run date: 2026-05-02

Metric definitions follow [Repository Full-Scan Evaluation Concepts](../README.md).

---

```bash
screen -S raddit-minimax27

# cd sec-review-bot

source .venv/bin/activate

sec-review-agents-run-local-repository \
  --repo raddit \
  --target-branch main \
  --output-dir .agent-workspace/raddit-repo-scan-minimax27
```

These counts describe how the muti-stage workflow behaved internally. They are diagnostic rather than main evaluation metrics.

**The Number Story (End-to-End):** 39 files traversed -> 39 scanned -discovery-> 105 candidates -triage-> 70 cases -analyzer-> 62 confirmed cases (+ 8 no-actionable) -mitigate & verifier-> 60 delivered cases -delivery-> 23 deliveries (15 combined + 8 single).

## Evaluation Summary

| Discovery and triage           | Result                                        |
| ------------------------------ | --------------------------------------------- |
| Benchmark recall at case level | 21 / 22 answer-key items became cases (95.5%) |
| Candidate and case volume      | 105 candidates, 70 cases                      |

| Analyzer judgment                  | Result                                     |
| ---------------------------------- | ------------------------------------------ |
| Benchmark recall at analyzer level | 21 / 22 answer-key items confirmed (95.5%) |
| Confirmed cases                    | 62                                         |

| Remediation                                 | Result                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Benchmark recall at final repair-plan level | 20 / 22 answer-key items covered (90.9%)                                                               |
| Remediation outcome                         | 20 / 22 complete, 2 missed (weak JWT secret, login rate limiting)                                      |
| Delivered cases                             | 60 cases across 23 deliveries                                                                          |
| Non-delivered cases                         | 10 cases did not reach final delivery                                                                  |
| Delivery quality                            | 9 ideal deliveries, 23 actual deliveries, delivery count gap +14                                       |
| Residual repair risks                       | weak JWT default, dependency lockfiles, deployment docs/config for required secrets and secure cookies |

| Manual review of final cases                | Result                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Clear answer-key miss                       | login rate limiting was not discovered                                                                        |
| Confirmed but not delivered answer-key item | weak JWT secret remained unfixed                                                                              |
| Reviewed case precision                     | TP / (TP + FP) = 30 / (30 + 1) = 96.8%                                                                        |
| False discovery rate                        | FP / (TP + FP) = 1 / (30 + 1) = 3.2%                                                                          |
| Extra cases after manual review             | 10 additional true positives, 25 duplicate / defense-in-depth cases, 4 non-security defects, 1 false positive |

Observed run cost from provider-reported token usage: $12.127009. Cache-adjusted estimate using the mimo-v2.5-pro observed cache ratio: $4.125246.

The workflow found almost all answer-key vulnerabilities during discovery/triage and analyzer judgment, but final repair-plan coverage is lower because the weak JWT secret case was confirmed and then not included in any delivery. All cases have structured analyzer judgments in the final artifacts.

## Benchmark Recall Against the Answer Key

|   # | Ground-truth vulnerability                           | Workflow result  | Evidence / case                                                                                                                                                            |
| --: | ---------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | SQL injection in `POST /api/auth/login`              | Found            | `bb6b44dc245ac9` fixed the login SQL query via parameterization.                                                                                                           |
|   2 | SQL injection in `GET /api/posts/search?q=`          | Found            | `eb44fff40ef2e0` covered keyword injection in `SearchPosts`.                                                                                                               |
|   3 | SQL injection in `GET /api/posts?sort=&order=`       | Found            | `e32d8c870cda8b` and `7982f11a125e43` covered `ListPosts` parameterization and ORDER BY allowlisting.                                                                      |
|   4 | Path traversal in file download                      | Found            | `4b3f10d3ec4fa8` covered unsanitized `name` in `DownloadFile`.                                                                                                             |
|   5 | Arbitrary file upload                                | Found            | `b6100eeb3de4b0` covered missing server-side file type validation; related upload hardening was merged with path and size checks.                                          |
|   6 | Command injection in ping tool                       | Found            | `6f9fd9b9f0f59f` fixed shell command construction in backend utility functions.                                                                                            |
|   7 | SSRF in URL preview                                  | Found            | `f18dfa691e818b`, `8e9cd5c9017896`, and `47bd5c29653e56` covered the unvalidated `PreviewURL` fetch path.                                                                  |
|   8 | IDOR delete post                                     | Found            | `9674c6e1ac72c6` covered missing ownership checks in `DeletePost`.                                                                                                         |
|   9 | Password hash exposure in user response              | Found            | `d2cbecc225a06b`, `d440f44b13375e`, and `0db0f43f3b933c` covered password serialization in API responses.                                                                  |
|  10 | User-controllable role privilege escalation          | Found            | `fbec8f72240496` covered user-modifiable `role` in profile updates.                                                                                                        |
|  11 | Weak JWT secret                                      | Missed at repair | `4b695590d1e80c` confirmed the hardcoded default JWT secret, but the case did not reach final delivery; final config snapshots still use `getEnv("JWT_SECRET", "secret")`. |
|  12 | JWT `alg:none` bypass                                | Found            | `2cb92f8cec6dad` fixed signature skipping for unsigned JWTs.                                                                                                               |
|  13 | Admin debug information disclosure                   | Found            | `84f7116f9d10c8` and `c4bec3daaf0a0c` removed sensitive debug response data.                                                                                               |
|  14 | Hardcoded admin credentials                          | Found            | `57350a0587ed7e` removed default `admin` / `admin123` fallback credentials and related exposure/logging.                                                                   |
|  15 | Plaintext password logging on failed login           | Found            | `55c80255f22ddb` removed plaintext password logging in failed login paths.                                                                                                 |
|  16 | Missing rate limiting on login                       | Missed           | No discovery candidate or triage case directly matched login brute-force / rate limiting.                                                                                  |
|  17 | Open redirect in login                               | Found            | `7b775a568688d5` validated the login redirect destination.                                                                                                                 |
|  18 | Stored XSS in post content                           | Found            | `419c430c642a0a`, `72d8a231b7997d`, and `ea73e0a254a1db` covered raw post content rendering.                                                                               |
|  19 | Stored XSS in comment content                        | Found            | `72bb364c436f88` and the shared XSS delivery covered raw comment rendering.                                                                                                |
|  20 | Reflected XSS in search query                        | Found            | `b684041c623efe` covered search query rendering with `dangerouslySetInnerHTML`.                                                                                            |
|  21 | Stored XSS in profile bio                            | Found            | `5771969e9bc1f3` covered raw profile bio rendering.                                                                                                                        |
|  22 | Missing CSRF protection for state-changing endpoints | Found            | `ad4b682cf7e2a3`, `6b84e0ed20350e`, `e04b22cf2ba743`, and `c5b97281137600` covered broad state-changing CSRF and logout CSRF.                                              |

Using binary benchmark recall against the ground truth: 21 / 22 answer-key items were detected as cases, and 20 / 22 were covered by the final repair plan.

The two final repair gaps are #11 weak JWT secret and #16 missing login rate limiting.

## Discovery and Triage Results

Discovery and triage are evaluated as scanner-like output: they provide security leads for later stages, comparable in role to Semgrep, CodeQL, ZAP, or other tools that surface candidate alerts. This run shows very broad discovery behavior: it covered nearly all localized answer-key vulnerabilities and produced many additional authorization, validation, session, and data-exposure cases.

Discovery produced 105 candidates, and triage converted 70 of them into cases while suppressing 24 lower-confidence candidates. The case set included SQL injection, XSS, path traversal, unsafe upload/download handling, command injection, SSRF, IDOR, JWT flaws, hardcoded credentials, sensitive-data exposure, redirect/CSRF issues, insecure session-cookie settings, and several defense-in-depth authorization checks.

The main discovery miss was login rate limiting. No candidate directly matched brute-force protection or login throttling. Rate limiting is an absent cross-cutting control, while discovery is much stronger on concrete sinks such as SQL string concatenation, raw HTML rendering, shell execution, and path joins.

### Extra Cases Outside Ground Truth

Manual review of delivered cases outside the answer key found 10 additional true positives, 25 duplicate / defense-in-depth cases, 4 non-security defects, and 1 false positive. Using the README definitions, duplicate cases and non-security defects are excluded from reviewed case precision and false discovery rate.

For reviewed case precision, manual review classified 30 cases as true positives and 1 case as a false positive. The 30 true positives are the 20 answer-key security surfaces represented in final deliveries plus 10 additional security surfaces credited in manual review.

| Reviewed precision component                                 | Count |
| ------------------------------------------------------------ | ----: |
| Answer-key security surfaces represented in final deliveries |    20 |
| Additional true-positive security surfaces                   |    10 |
| Reviewed true positives                                      |    30 |
| Reviewed false positives                                     |     1 |

Representative valid additional cases include:

| Case             | Claim                                                                     | Manual review                                                                                       |
| ---------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `5d59bfd450e1b3` | JWT token stored in `localStorage`, increasing XSS impact.                | Valid additional security issue.                                                                    |
| `7e249f430f0bf4` | File download endpoint lacks authorization.                               | Valid additional issue; separate from path traversal.                                               |
| `bd3b84d2e17242` | Upload path traversal via original filename.                              | Valid additional issue; distinct from download traversal.                                           |
| `dacfd69ff1aefd` | Unbounded file uploads.                                                   | Valid additional availability issue.                                                                |
| `c36038c701581b` | Session cookie missing `Secure` flag.                                     | Valid additional session-hardening issue.                                                           |
| `d45772cac0e103` | Race condition in `VotePost`.                                             | Valid lower-impact integrity issue.                                                                 |
| `73a7d0678204f1` | Edit-post route exposes post content through an ID-derived frontend path. | Valid additional access-control / information-disclosure issue; backend mutation remains protected. |
| `7d1d33736010b2` | Sensitive profile changes do not require current-password verification.   | Valid additional account-hardening issue, especially after session theft.                           |

Representative duplicate or overlapping cases include:

| Case                                                                   | Claim                                                             | Manual review                                                                                                      |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `6407c733d79a5b` / `c25e740555eca9`                                    | Client-side-only edit/delete gates.                               | Overlaps answer-key delete-post IDOR; final repair contributes to server-side authorization.                       |
| `7be9ebbbf50f1a`                                                       | Admin password written to logs.                                   | Overlaps hardcoded/default admin credential surface.                                                               |
| `7ab9ef14dfa893`                                                       | Potential missing auth on `SystemInfo`.                           | Overlaps admin debug information disclosure and auth-boundary review.                                              |
| `4aaaac642afea6`                                                       | Missing explicit admin authorization in `ListUsers`.              | Defense-in-depth / duplicate because the `/api/admin` route group already uses `AuthRequired` and `AdminRequired`. |
| `325c4408020e90`, `419c430c642a0a`, `72d8a231b7997d`, `ea73e0a254a1db` | Multiple post-content XSS formulations.                           | Overlapping XSS cases merged into shared sanitizer delivery.                                                       |
| `e6e6030c9dd9b7`                                                       | Profile IDOR / password-hash exposure through user profile reads. | Overlaps the answer-key password-hash exposure surface and related user-serialization fixes.                       |

Representative non-security defects include:

| Case             | Claim                                            | Manual review                                                                                                                                      |
| ---------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `518b1490fac4f1` | Silent authentication failure handling.          | Valid UX/telemetry defect, but not a security vulnerability because invalid tokens are still cleared and protected routes still redirect.          |
| `cf78dc5a04088b` | Missing validation on login function parameters. | Frontend hardening issue only; exploitation requires a separate backend compromise or malicious API response.                                      |
| `f4cba8954da138` | Unchecked email uniqueness on update.            | Database uniqueness prevents duplicate-email integrity compromise; the remaining issue is error handling.                                          |
| `aaa4d7bcc62bf8` | Comment listing lacks post access control.       | Low-confidence security boundary in this repository because posts have no private visibility model; best treated as a product/access-model defect. |

Reviewed false positives are cases whose security claim does not hold under the repository's actual trust boundaries:

| Case             | Claim                              | Manual review                                                                                                                                 |
| ---------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `7fd0b7d7454921` | Missing auth on `AdminDeleteUser`. | False positive as a standalone security finding: `backend/main.go` registers `/api/admin` behind both `AuthRequired()` and `AdminRequired()`. |

### Suppression Behavior

Triage suppressed 24 candidates. The suppressions were mostly lower-confidence or client-side-only observations, generic hardening observations without a concrete exploit path, and candidates subsumed by stronger cases. The main risk is that absent cross-cutting controls, especially login rate limiting, can be missed unless discovery explicitly asks for them.

## Analyzer Judgment Results

Analyzer judgment is the vulnerability-confirmation layer: it decides whether cases should proceed as real security cases. All 70 cases have structured analyzer judgments.

| Analyzer outcome            | Count |
| --------------------------- | ----: |
| Confirmed vulnerability     |    50 |
| Confirmed repository defect |    12 |
| No actionable hypothesis    |     8 |

No cases are blocked because of missing analyzer structured output. Six cases that are especially relevant to final delivery mechanics are:

| Case             | Title                                                              | Final verifier coverage |
| ---------------- | ------------------------------------------------------------------ | ----------------------- |
| `47bd5c29653e56` | Arbitrary URL Fetching Without Client-Side Validation              | full                    |
| `7be9ebbbf50f1a` | Plaintext Admin Password Written to Logs                           | full                    |
| `7fd0b7d7454921` | Missing auth on AdminDeleteUser                                    | full                    |
| `ad4b682cf7e2a3` | Missing CSRF protection on authenticated state-changing operations | full                    |
| `bb6b44dc245ac9` | SQL injection in Login                                             | full                    |
| `e04b22cf2ba743` | Potential CSRF on vote/delete operations                           | full                    |

All six are confirmed, verified, and included in final deliveries. This workflow status is separate from manual extra-case scoring: `7fd0b7d7454921` is delivered, but is not credited as an additional true positive because the `/api/admin` route group is already protected by `AuthRequired()` and `AdminRequired()`.

## Delivery Results And Evaluation

Raddit defines 9 ideal deliveries in [raddit/VULNERABILITIES.md](https://github.com/Agent-AI-Chalmers/raddit/blob/answer/VULNERABILITIES.md); this run produced 23 actual deliveries.

| Delivery metric    | Count |
| ------------------ | ----: |
| Ideal deliveries   |     9 |
| Actual deliveries  |    23 |
| Delivery count gap |   +14 |

The delivery planning received only retained, combinable cases. Patch synthesis materialized all 23 planned deliveries as publishable artifacts. The 10 cases that did not reach delivery had already stopped before planning: nine produced no applied patch, and one was rejected by the verifier for patch synthesis.

The `+14` gap comes from a mix of useful grouping and residual fragmentation. Search/List SQL injection, file upload/download hardening, frontend XSS, and several auth/admin repairs were consolidated, but server-side outbound interaction safety, user authorization/profile data controls, JWT/default credential hardening, and CSRF/auth-flow work remained split across multiple deliveries. Some actual deliveries also bundled adjacent but distinct ideal deliveries, such as login SQL/password logging/open redirect with CSRF and session-cookie hardening.

## CVSS and Prioritization

The CVSS v4 stage scored 62 cases.

| Critical | High | Medium | Low | None |
| -------: | ---: | -----: | --: | ---: |
|       20 |   24 |     15 |   1 |    2 |

The scoring stage broadly prioritizes the severe implementation bugs near the top: unauthenticated SQL injection, SSRF, JWT bypass, hardcoded credentials, path traversal, command injection, and admin/data exposure. The high number of critical and high cases reflects MiniMax's broader case set, including several adjacent authorization and exposure defects beyond the answer key.

Two cases were scored as `0.0 / none`; eight cases were unscored. These are mostly lower-confidence or no-actionable analyzer outcomes rather than final answer-key blockers.

## Token and Cost Summary

Cost is estimated with the built-in `minimax-m2.7` USD price profile: $0.30 per 1M uncached input tokens, $0.06 per 1M cached input tokens, and $1.20 per 1M output tokens.

```bash
python -m scripts.token_usage.summarize .agent-workspace/raddit-repo-scan-minimax27/local-run-20260502T003113Z-1a68e255
```

| Scope    | Input tokens | Output tokens | Cache-read tokens | Uncached input tokens | Estimated cost |
| -------- | -----------: | ------------: | ----------------: | --------------------: | -------------: |
| Full run |   36,166,857 |     1,064,127 |                 0 |            36,166,857 |     $12.127009 |

The observed run artifacts report `0` cache-read tokens. For cross-run comparison, a cache-adjusted estimate is also reported by applying the mimo-v2.5-pro observed cache ratio to the MiniMax input volume:

```text
mimo cache ratio = 28,405,952 / 30,813,829 = 92.185726%
estimated MiniMax cache-read tokens = 36,166,857 * 92.185726% = 33,340,680
estimated MiniMax uncached input tokens = 2,826,177
cache-adjusted MiniMax cost = $4.125246
```

The stage table reports aggregate usage across all agent calls in each stage, not per-call or per-case averages.

| Stage             | Total input tokens | Total output tokens | Total cache-read tokens | Estimated stage cost (USD) |
| ----------------- | -----------------: | ------------------: | ----------------------: | -------------------------: |
| Discovery         |            204,814 |              41,861 |                       0 |                  $0.111677 |
| Triage            |             38,090 |              18,925 |                       0 |                  $0.034137 |
| Triage refiner    |             15,881 |               3,259 |                       0 |                  $0.008675 |
| Analysis          |          9,948,635 |             243,902 |                       0 |                  $3.277272 |
| CVSS v4 scoring   |          1,083,530 |             142,593 |                       0 |                  $0.496170 |
| Mitigation        |         11,257,436 |             220,235 |                       0 |                  $3.641513 |
| Verification      |          7,040,689 |             267,645 |                       0 |                  $2.433381 |
| Delivery planning |            582,594 |              16,666 |                       0 |                  $0.194777 |
| Patch synthesis   |          5,995,188 |             109,041 |                       0 |                  $1.929406 |

## Remaining Gaps

### #11 Weak JWT Secret

The workflow produced and confirmed case `4b695590d1e80c`, `Hardcoded Default JWT Secret 'secret'`, but that case did not reach final delivery. The final `backend/config/config.go` snapshot in the admin credential delivery still contains:

```go
JWTSecret = getEnv("JWT_SECRET", "secret")
```

This should be treated as a repair-stage miss, not a discovery-stage miss.

### #16 Missing Login Rate Limiting

No matching discovery candidate was found for rate limiting or brute-force protection. This remains the clearest discovery-stage false negative.

Likely reason: missing rate limiting is a negative control across route behavior, not a localized dangerous sink. SQL concatenation, raw HTML rendering, command execution, and unsafe file paths all have obvious evidence snippets; the absence of rate limiting requires broader architectural reasoning across middleware and route registration.
