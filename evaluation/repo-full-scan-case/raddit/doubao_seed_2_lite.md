# Raddit Repository Full Scan: Doubao Seed 2.0 Lite

## Scope

This report compares the repository scan workflow output for the Raddit benchmark against the manually injected ground truth in [raddit/VULNERABILITIES.md](https://github.com/Agent-AI-Chalmers/raddit/blob/answer/VULNERABILITIES.md).

- Target repository: `raddit` main workspace
- Ground truth: [raddit/VULNERABILITIES.md](https://github.com/Agent-AI-Chalmers/raddit/blob/answer/VULNERABILITIES.md)
- Model configuration: `anthropic/doubao-seed-2.0-lite`
- Run identifier: `local-run-20260502T151836Z-1d44b29a`
- Run date: 2026-05-02

Metric definitions follow [Repository Full-Scan Evaluation Concepts](../README.md).

---

```bash
screen -S raddit-Doubao-Seed-2.0-lite

# cd sec-review-bot

source .venv/bin/activate

sec-review-agents-run-local-repository \
  --repo raddit \
  --target-branch main \
  --output-dir .agent-workspace/raddit-repo-scan-Doubao-Seed-2.0-lite
```

These counts describe how the muti-stage workflow behaved internally. They are diagnostic rather than main evaluation metrics.

**The Number Story (End-to-End):** 39 files traversed -> 39 scanned -discovery-> 49 candidates -triage-> 43 cases -analyzer-> 43 confirmed cases -mitigate & verifier-> 43 delivered cases -delivery-> 43 deliveries (0 combined + 43 single).

## Evaluation Summary

| Discovery and triage           | Result                                        |
| ------------------------------ | --------------------------------------------- |
| Benchmark recall at case level | 15 / 22 answer-key items became cases (68.2%) |
| Candidate and case volume      | 49 candidates, 43 cases                       |

| Analyzer judgment                  | Result                                     |
| ---------------------------------- | ------------------------------------------ |
| Benchmark recall at analyzer level | 15 / 22 answer-key items confirmed (68.2%) |
| Confirmed cases                    | 43                                         |

| Remediation                                 | Result                                                                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Benchmark recall at final repair-plan level | 15 / 22 answer-key items covered by a patch attempt (68.2%)                                                                                                                                      |
| Remediation outcome                         | 14 / 22 complete, 1 incomplete, 7 missed                                                                                                                                                         |
| Delivered cases                             | 43 cases across 43 deliveries                                                                                                                                                                    |
| Non-delivered cases                         | 0 cases                                                                                                                                                                                          |
| Delivery quality                            | 9 ideal deliveries, 43 actual deliveries, delivery count gap +34                                                                                                                                 |
| Residual repair risks                       | no combined patch synthesis, weak JWT default remains in non-production defaults, non-security defects and false positives proceeded to delivery, dependency lockfile and deployment config risk |

| Manual review of final cases    | Result                                                                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clear answer-key misses         | login SQL injection, search SQL injection, password hash exposure, role privilege escalation, JWT `alg:none`, failed-login password logging, login rate limiting |
| Incomplete answer-key repair    | weak JWT secret                                                                                                                                                  |
| Reviewed case precision         | TP / (TP + FP) = 22 / (22 + 3) = 88.0%                                                                                                                           |
| False discovery rate            | FP / (TP + FP) = 3 / (22 + 3) = 12.0%                                                                                                                            |
| Extra cases after manual review | 7 additional true-positive security surfaces, 1 deployment-hardening risk, overlapping duplicate cases, 6 non-security defects, 3 false positives                |

Estimated run cost: $2.416956.

Doubao Seed 2.0 Lite completed the full workflow and produced structured analyzer judgments for all retained cases. It found 15 of the 22 answer-key items and covered many concrete sink-style vulnerabilities: ListPosts SQL ordering injection, file upload/download issues, command injection, SSRF, delete-post authorization, open redirect, XSS, CSRF, admin debug exposure, hardcoded admin credentials, and weak JWT defaults. The largest structural caveat is the delivery stage: all 43 deliveries are single deliveries, so overlapping fixes were not synthesized into combined patch sets.

## Benchmark Recall Against the Answer Key

|   # | Ground-truth vulnerability                           | Workflow result | Evidence / case                                                                                                                                       |
| --: | ---------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | SQL injection in `POST /api/auth/login`              | Missed          | No retained case targeted the login SQL query in `backend/handlers/auth.go`.                                                                          |
|   2 | SQL injection in `GET /api/posts/search?q=`          | Missed          | Search-related cases focused on frontend reflected XSS, not the backend search SQL query.                                                             |
|   3 | SQL injection in `GET /api/posts?sort=&order=`       | Found           | `9d7e10bdb9ef7b` added allowlists for `sort`, `order`, and `subreddit` before constructing the ListPosts query.                                       |
|   4 | Path traversal in file download                      | Found           | `0e7f6c8000fdaa` normalized download filenames with `filepath.Base` and joined paths under the upload directory.                                      |
|   5 | Arbitrary file upload                                | Found           | `3abf58ad6ca00c`, `72f101d99f99f6`, and `a0e014fa6fc416` covered upload type, path, and size hardening.                                               |
|   6 | Command injection in ping tool                       | Found           | `782ecec162e9ad` removed shell-style command construction and validated host input; related tool exposure was also hardened.                          |
|   7 | SSRF in URL preview                                  | Found           | `0b6d6005ae74c1` and `d8f91722a968a4` covered unvalidated preview URL flow to the backend.                                                            |
|   8 | IDOR delete post                                     | Found           | `4808104392ab56` added owner/admin authorization checks to `DeletePost`; the same patch also hardened `UpdatePost`.                                   |
|   9 | Password hash exposure in user response              | Missed          | No retained case targeted password serialization in user API responses.                                                                               |
|  10 | User-controllable role privilege escalation          | Missed          | Client-side admin/navigation checks were found, but the backend role update surface was not fixed.                                                    |
|  11 | Weak JWT secret                                      | Incomplete      | `8a16ed9f1de1bd` added a production-mode fatal check for `JWT_SECRET == "secret"`, but the default fallback remains `getEnv("JWT_SECRET", "secret")`. |
|  12 | JWT `alg:none` bypass                                | Missed          | No retained case targeted unsigned JWT acceptance or algorithm validation.                                                                            |
|  13 | Admin debug information disclosure                   | Found           | `4fcd96d190d681` removed sensitive debug exposure.                                                                                                    |
|  14 | Hardcoded admin credentials                          | Found           | `b180b5eec7988c` removed default admin credentials and related initialization exposure.                                                               |
|  15 | Plaintext password logging on failed login           | Missed          | `81331224d31d38` addressed admin initialization logging, not failed-login password logging.                                                           |
|  16 | Missing rate limiting on login                       | Missed          | A client-side rate-limiting candidate was suppressed; no backend login throttling case was retained.                                                  |
|  17 | Open redirect in login                               | Found           | `1019abfe060b7d` validated login redirect destinations; `ff16e9dc8abd8f` covered logout redirect handling.                                            |
|  18 | Stored XSS in post content                           | Found           | `3a426e69d49038`, `34cd3b50956b30`, and `ac1feb94481b10` covered unsanitized post rendering/submission paths.                                         |
|  19 | Stored XSS in comment content                        | Found           | `3a426e69d49038` covered comment rendering through shared `dangerouslySetInnerHTML` sanitization.                                                     |
|  20 | Reflected XSS in search query                        | Found           | `88d09155d7d91c` and the shared XSS delivery covered search query rendering.                                                                          |
|  21 | Stored XSS in profile bio                            | Found           | `3a426e69d49038` covered profile bio rendering.                                                                                                       |
|  22 | Missing CSRF protection for state-changing endpoints | Found           | `3c2f2672d45a58`, `48f321dc2af3d8`, `ba682a2e56e5cd`, and `bbdc37484e7fb9` covered Origin/Referer checks and state-changing request hardening.        |

Using binary benchmark recall against the ground truth: 15 / 22 answer-key items were detected as cases, and 15 / 22 received a repair attempt. One of those repair attempts, weak JWT secret, is incomplete because the default secret remains available outside production mode.

## Discovery and Triage Results

Discovery produced 49 candidates, and triage converted 43 of them into cases while suppressing 5 lower-confidence candidates. The retained case set emphasized concrete frontend/backend evidence: raw HTML rendering, path joins, shell command construction, URL preview and network utility inputs, CSRF gaps, default secrets, admin/debug configuration, and file upload/download behavior.

The most important discovery misses were login SQL injection, search SQL injection, password hash exposure, role privilege escalation, JWT `alg:none`, failed-login password logging, and login rate limiting.

### Extra Cases Outside Ground Truth

Manual review classified 22 cases as true positives and 3 cases as false positives for the reviewed case precision calculation. The 22 true positives are the 15 represented answer-key security surfaces plus the 7 additional security surfaces below. Duplicate/overlapping cases, non-security defects, and deployment-hardening-only items are excluded from the precision denominator, following the README definition.

| Reviewed precision component               | Count |
| ------------------------------------------ | ----: |
| Answer-key security surfaces represented   |    15 |
| Additional true-positive security surfaces |     7 |
| Reviewed true positives                    |    22 |
| Reviewed false positives                   |     3 |

Manual review found several additional security surfaces outside the 22-item answer key:

| Case             | Claim                                                       | Manual review                                                                        |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `007245b9d9fe65` | Vite 5.4.21 known vulnerability.                            | Valid supply-chain/dependency issue, outside the injected answer key.                |
| `3561dfd75d447d` | Missing authorization check for file downloads.             | Valid additional authorization issue.                                                |
| `a0e014fa6fc416` | Unrestricted upload size.                                   | Valid additional availability issue.                                                 |
| `b355253b8d13ea` | Token stored in `localStorage`.                             | Valid additional issue that increases XSS impact.                                    |
| `50554fe2f4acb9` | Network utility endpoints exposed without authentication.   | Valid additional authorization issue.                                                |
| `939db4c443e6a3` | Static serving from the upload directory.                   | Valid additional file-exposure hardening issue.                                      |
| `e3d8fceaa35493` | Missing ownership/authorization check before editing posts. | Valid additional IDOR issue for edit, separate from the answer-key delete-post IDOR. |

Deployment-hardening items are tracked separately from additional true positives:

| Case             | Claim                             | Manual review                                                                                                                                                                                                                  |
| ---------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `8a5b3b5d79590d` | Permissive CORS with credentials. | Deployment/config hardening risk. The repository uses explicit localhost origins rather than wildcard credentials, so this is not counted as a concrete additional vulnerability without evidence of a hostile allowed origin. |

Representative duplicate or overlapping cases include:

| Case                                                                                     | Claim                                                      | Manual review                                                                             |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `0b6d6005ae74c1` / `d8f91722a968a4`                                                      | Unvalidated preview URL / arbitrary URL passed to backend. | Overlapping SSRF formulations.                                                            |
| `13efb6ab1dcf09`, `3abf58ad6ca00c`, `72f101d99f99f6`, `a0e014fa6fc416`                   | Upload type, path, and size hardening.                     | Overlapping arbitrary-upload and upload-hardening surfaces.                               |
| `3a426e69d49038`, `34cd3b50956b30`, `88d09155d7d91c`, `ac1feb94481b10`, `c655ba81dca23e` | Multiple frontend XSS and HTML-sanitization cases.         | Overlapping XSS surfaces.                                                                 |
| `3c2f2672d45a58`, `48f321dc2af3d8`, `ba682a2e56e5cd`, `bbdc37484e7fb9`                   | Multiple CSRF formulations.                                | Overlapping CSRF surfaces.                                                                |
| `1019abfe060b7d` / `ff16e9dc8abd8f`                                                      | Login/logout redirect validation.                          | Related open-redirect surfaces.                                                           |
| `782ecec162e9ad`, `c334f379a2d2cf`, `50554fe2f4acb9`                                     | Command injection and network utility exposure.            | Overlapping tool-hardening surfaces; one removes shell execution, others restrict access. |

Representative non-security defects include:

| Case             | Claim                                                  | Manual review                                                                                      |
| ---------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `0901a769ed527d` | Subreddit selection accepts any client-provided value. | Valid product/data-integrity validation issue, but not a security vulnerability in this benchmark. |
| `67edaa6a52c6cb` | Missing client-side comment length validation.         | UX/availability hardening, not a direct security vulnerability by itself.                          |
| `8f4edb0d8100b0` | Profile page accessible without authentication.        | Does not remove the password-hash exposure sink; at most narrows access to authenticated users.    |
| `9b7d83669cafdf` | User ID extraction ignores errors.                     | Robustness defect for handlers expected to run behind auth middleware.                             |
| `ba935bd46c4944` | Global database variable.                              | Maintainability/testability defect rather than a direct vulnerability in this benchmark.           |
| `d417638cb9b996` | Default bcrypt cost may be insufficient.               | Hardening recommendation; not a concrete benchmark vulnerability.                                  |

Reviewed false positives are cases whose security claim does not hold under the repository's actual trust boundaries:

| Case             | Claim                                             | Manual review                                                                                                      |
| ---------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `2654b24aafc75a` | Admin API calls need client-side admin checks.    | False positive as a security finding: backend `/api/admin` routes already use `AuthRequired` and `AdminRequired`.  |
| `3f3fb6fbdc2651` | Client-side-only role check for admin navigation. | False positive as a security finding: hiding or showing a nav link is not the authorization boundary.              |
| `d33c13a6e18cf8` | XSS from server output rendered in `<pre>` tags.  | False positive: React text children are escaped; no `dangerouslySetInnerHTML` sink is used in this rendering path. |

### Suppression Behavior

Triage suppressed 5 candidates. Suppressed items included `.gitignore` observations without committed secrets, a generic outdated-dependency claim without a concrete CVE, a client-side-only CSRF observation, and a client-side login rate-limiting observation. The login-rate-limiting suppression is relevant to the answer-key miss: the retained workflow never produced a backend login throttling case.

## Analyzer Judgment Results

Analyzer judgment is the vulnerability-confirmation layer: it decides whether cases should proceed as real security cases. All 43 retained cases have structured analyzer judgments.

| Analyzer outcome                | Count |
| ------------------------------- | ----: |
| Confirmed vulnerability         |    35 |
| Confirmed repository defect     |     8 |
| No actionable hypothesis        |     0 |
| Explicit trigger rejection      |     0 |
| Unavailable structured judgment |     0 |

No cases were blocked because of missing analyzer structured output. The analyzer was permissive in this run: every retained case proceeded to mitigation and delivery, including several non-security defects and three reviewed false-positive security claims.

## Delivery Results And Evaluation

Raddit defines 9 ideal deliveries in [raddit/VULNERABILITIES.md](https://github.com/Agent-AI-Chalmers/raddit/blob/answer/VULNERABILITIES.md); this run produced 43 actual deliveries.

| Delivery metric    | Count |
| ------------------ | ----: |
| Ideal deliveries   |     9 |
| Actual deliveries  |    43 |
| Delivery count gap |   +34 |

The delivery planning received only retained, combinable cases. Patch synthesis materialized all 43 planned deliveries as publishable artifacts, but all of them were single-case deliveries.

The `+34` gap comes from almost no delivery consolidation. Overlapping XSS, CSRF, file-handling, redirect, SSRF/network-tool, and upload-hardening repairs were emitted as separate artifacts rather than synthesized into reviewable repair groups. This run therefore demonstrates case-by-case mitigation, but its delivery set is not an integrated review plan.

## CVSS and Prioritization

The CVSS v4 stage scored 43 cases.

| Critical | High | Medium | Low | None |
| -------: | ---: | -----: | --: | ---: |
|        7 |   18 |     15 |   0 |    3 |

Average base score was 6.99, and the maximum base score was 9.3. The severe cases include command injection, SSRF, SQL injection, path traversal, CSRF, and high-impact XSS/authorization surfaces. Three cases were scored as `none`, which aligns with the presence of repository-defect or hardening cases that are not direct vulnerabilities.

## Token and Cost Summary

Cost is estimated with the built-in Doubao Seed 2.0 Lite USD price profile. The official [Seed2.0 model card](https://lf3-static.bytednsdoc.com/obj/eden-cn/lapzild-tss/ljhwZthlaukjlkulzlp/seed2/0214/Seed2.0%20Model%20Card.pdf) reports representative USD prices for interval-priced Seed2.0 models; cache-hit input is priced at 20% of normal input following the [Volcengine cache-hit pricing rule](https://www.volcengine.com/docs/84458/1585097). This run reported cache-read tokens, and the total observed cache ratio was 46.15%.

```bash
python -m scripts.token_usage.summarize .agent-workspace/raddit-repo-scan-Doubao-Seed-2.0-lite/local-run-20260502T151836Z-1d44b29a
```

| Scope    | Input tokens | Output tokens | Cache-read tokens | Uncached input tokens | Estimated cost |
| -------- | -----------: | ------------: | ----------------: | --------------------: | -------------: |
| Full run |   37,875,904 |       503,223 |        17,480,328 |            20,395,576 |      $2.416956 |

The stage table reports aggregate usage across all agent calls in each stage, not per-call or per-case averages.

| Stage             | Total input tokens | Total output tokens | Total cache-read tokens | Estimated stage cost (USD) |
| ----------------- | -----------------: | ------------------: | ----------------------: | -------------------------: |
| Discovery         |            178,443 |              19,900 |                       0 |                  $0.026607 |
| Triage            |             22,835 |               3,730 |                       0 |                  $0.004032 |
| Triage refiner    |             11,198 |               1,005 |                       0 |                  $0.001540 |
| Analysis          |          8,686,628 |              70,517 |               2,596,000 |                  $0.632259 |
| CVSS v4 scoring   |          1,101,406 |              47,381 |                       0 |                  $0.124238 |
| Mitigation        |         17,629,797 |             190,135 |              11,494,912 |                  $0.859820 |
| Verification      |          6,717,920 |              91,484 |               3,389,416 |                  $0.409061 |
| Delivery planning |          3,527,677 |              79,071 |                       0 |                  $0.359399 |

## Remaining Gaps

### SQL Injection Coverage

The run found the ListPosts `sort` / `order` injection surface, but missed login SQL injection and SearchPosts SQL injection. This suggests the discovery pass was less complete on backend SQL sink enumeration than the other available agentic runs.

### Authorization Coverage

The run found file-download authorization, edit-post authorization, and the answer-key delete-post IDOR. It still missed profile role escalation, and several client-side admin-route findings were retained even though they do not replace backend authorization checks.

### JWT Coverage

The run identified the weak default JWT secret, but the generated patch keeps `JWTSecret = getEnv("JWT_SECRET", "secret")` and only fails in production mode. It also missed the JWT `alg:none` bypass entirely.

### Delivery Integration

All final deliveries are single deliveries. The run therefore demonstrates mitigation capability case-by-case, but not integrated delivery planning for overlapping fixes.
