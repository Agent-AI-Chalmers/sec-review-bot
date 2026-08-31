# Repo Full-Scan on Raddit - Comparison

## Scope

This report compares the Raddit repository full-scan reports in this directory.

- Benchmark answer key: [raddit/VULNERABILITIES.md](https://github.com/Agent-AI-Chalmers/raddit/blob/answer/VULNERABILITIES.md)
- Public target repository: [Agent-AI-Chalmers/raddit](https://github.com/Agent-AI-Chalmers/raddit)
- Scanned branch: `main` (`origin/main` at `d88a43e`)
- Answer-key branch: `answer` (`origin/answer` at `565c483`)
- Answer-key size: 22 vulnerabilities
- Ideal deliveries: 9 reviewer-oriented delivery groups
- Agentic full-scan runs:
  - [mimo-v2.5-pro](./mimo-v2.5-pro.md)
  - [MiniMax M2.7](./minimax-m2.7.md)
  - [Doubao Seed 2.0 Lite](./doubao_seed_2_lite.md)
- Tool-based reports:
  - [CodeQL code scanning alerts](./CodeQL/CodeQL.md)
  - [Semgrep code and supply-chain findings](./Semgrep/Semgrep.md)
  - [OWASP ZAP frontend and API alerts](./zap/zap.md)
- Metric definitions follow [Repository Full-Scan Evaluation Concepts](../README.md).

The agentic workflow reports include discovery, analyzer judgment, remediation, delivery, and token-cost metrics. CodeQL, Semgrep, and ZAP are scanner-style reports, so they are compared at answer-key detection coverage and reviewed precision; they do not have remediation or delivery metrics.

## Headline Metrics

| Metric                                            | mimo-v2.5-pro          | MiniMax M2.7          | Doubao Seed 2.0 Lite                | CodeQL               | Semgrep                                 | ZAP                      |
| ------------------------------------------------- | ---------------------- | --------------------- | ----------------------------------- | -------------------- | --------------------------------------- | ------------------------ |
| Scanner-style outputs                             | 45 cases               | 70 cases              | 43 cases                            | 11 alerts            | 10 findings                             | 16 reviewed alert groups |
| Confirmed cases                                   | 35                     | 62                    | 43                                  | N/A                  | N/A                                     | N/A                      |
| Delivered cases                                   | 34                     | 60                    | 43                                  | N/A                  | N/A                                     | N/A                      |
| Deliveries                                        | 14                     | 23                    | 43                                  | N/A                  | N/A                                     | N/A                      |
| Answer-key recall at case / alert / finding level | 21 / 22 (95.5%)        | 21 / 22 (95.5%)       | 15 / 22 (68.2%)                     | 7 / 22 (31.8%)       | 8 / 22 (36.4%)                          | 3 / 22 (13.6%)           |
| Answer-key recall at analyzer level               | 21 / 22 (95.5%)        | 21 / 22 (95.5%)       | 15 / 22 (68.2%)                     | N/A                  | N/A                                     | N/A                      |
| Answer-key recall at final repair-plan level      | 21 / 22 (95.5%)        | 20 / 22 (90.9%)       | 15 / 22 (68.2%)                     | N/A                  | N/A                                     | N/A                      |
| Answer-key remediation outcome                    | 21 complete, 1 missed  | 20 complete, 2 missed | 14 complete, 1 incomplete, 7 missed | N/A                  | N/A                                     | N/A                      |
| Delivery count gap                                | +5                     | +14                   | +34                                 | N/A                  | N/A                                     | N/A                      |
| Reviewed precision                                | 29 / (29 + 0) = 100.0% | 30 / (30 + 1) = 96.8% | 22 / (22 + 3) = 88.0%               | 8 / (8 + 0) = 100.0% | 8 / (8 + 0) = 100.0%                    | 11 / (11 + 1) = 91.7%    |
| False discovery rate                              | 0 / (29 + 0) = 0.0%    | 1 / (30 + 1) = 3.2%   | 3 / (22 + 3) = 12.0%                | 0 / (8 + 0) = 0.0%   | 0 / (8 + 0) = 0.0%                      | 1 / (11 + 1) = 8.3%      |
| Extra security surfaces outside answer key        | 8 additional TP        | 10 additional TP      | 7 additional TP                     | 1                    | 0 code, plus 10 supply-chain advisories | 8 hardening surfaces     |
| Observed run cost                                 | $10.691960             | $12.127009            | $2.416956                           | N/A                  | N/A                                     | N/A                      |
| Cache-adjusted run cost                           | $10.691960             | $4.125246             | $2.416956                           | N/A                  | N/A                                     | N/A                      |

## Answer-Key Coverage

All six reports are mapped to the same 22-item Raddit answer key.

For the agentic runs, the table records final repair-plan/remediation status: `Found` means the answer-key item is completely covered by the final repair plan, `Found, not repaired` means it was discovered and confirmed but did not reach final delivery, and `Found, incomplete` means a repair attempt exists but leaves part of the answer-key issue open. For CodeQL, Semgrep, and ZAP, the table records scanner-style detection status only because those tools do not produce repairs.

| Answer-key item                                 | mimo-v2.5-pro | MiniMax M2.7        | Doubao Seed 2.0 Lite | CodeQL | Semgrep Code | ZAP    |
| ----------------------------------------------- | ------------- | ------------------- | -------------------- | ------ | ------------ | ------ |
| #1 Login SQL injection                          | Found         | Found               | Missed               | Found  | Found        | Missed |
| #2 SearchPosts SQL injection                    | Found         | Found               | Missed               | Found  | Found        | Found  |
| #3 ListPosts SQL injection                      | Found         | Found               | Found                | Found  | Found        | Missed |
| #4 File download path traversal                 | Found         | Found               | Found                | Found  | Missed       | Missed |
| #5 Arbitrary file upload                        | Found         | Found               | Found                | Missed | Missed       | Missed |
| #6 Command injection in ping tool               | Found         | Found               | Found                | Found  | Found        | Found  |
| #7 SSRF in URL preview                          | Found         | Found               | Found                | Found  | Found        | Missed |
| #8 IDOR delete post                             | Found         | Found               | Found                | Missed | Missed       | Missed |
| #9 Password hash exposure in user response      | Found         | Found               | Missed               | Missed | Missed       | Found  |
| #10 User-controllable role privilege escalation | Found         | Found               | Missed               | Missed | Missed       | Missed |
| #11 Weak JWT secret                             | Found         | Found, not repaired | Found, incomplete    | Missed | Missed       | Missed |
| #12 JWT `alg:none` bypass                       | Found         | Found               | Missed               | Missed | Missed       | Missed |
| #13 Admin debug information disclosure          | Found         | Found               | Found                | Missed | Missed       | Missed |
| #14 Hardcoded admin credentials                 | Found         | Found               | Found                | Missed | Missed       | Missed |
| #15 Plaintext password logging on failed login  | Found         | Found               | Missed               | Found  | Missed       | Missed |
| #16 Missing rate limiting on login              | Missed        | Missed              | Missed               | Missed | Missed       | Missed |
| #17 Open redirect in login                      | Found         | Found               | Found                | Missed | Missed       | Missed |
| #18 Stored XSS in post content                  | Found         | Found               | Found                | Missed | Found        | Missed |
| #19 Stored XSS in comment content               | Found         | Found               | Found                | Missed | Found        | Missed |
| #20 Reflected XSS in search query               | Found         | Found               | Found                | Missed | Found        | Missed |
| #21 Stored XSS in profile bio                   | Found         | Found               | Found                | Missed | Missed       | Missed |
| #22 Missing CSRF protection                     | Found         | Found               | Found                | Missed | Missed       | Missed |

At scanner-style case level, mimo-v2.5-pro and MiniMax M2.7 each covered 21 / 22 answer-key items, while Doubao Seed 2.0 Lite covered 15 / 22. The final repair-plan table applies the stricter remediation outcome for MiniMax because the weak JWT secret was confirmed but not delivered. CodeQL covered 7 / 22, Semgrep Code covered 8 / 22, and ZAP covered 3 / 22 at detection level.

### Issue Category Coverage

The Raddit answer-key category taxonomy is defined in [raddit/VULNERABILITIES.md](https://github.com/Agent-AI-Chalmers/raddit/blob/answer/VULNERABILITIES.md). CodeQL and Semgrep mainly cover sink-style findings, while the agentic runs also cover access-control, token-design, configuration/data-exposure issues, and part of the missing-control category. ZAP covered two sink-style backend findings and one sensitive-data exposure finding in the combined frontend/API run.

| Category                                  | mimo-v2.5-pro | MiniMax M2.7 | Doubao Seed 2.0 Lite | CodeQL | Semgrep Code |    ZAP |
| ----------------------------------------- | ------------: | -----------: | -------------------: | -----: | -----------: | -----: |
| Injection, request, and renderer sinks    |       10 / 10 |      10 / 10 |               8 / 10 | 6 / 10 |       8 / 10 | 2 / 10 |
| Access-control and account-state logic    |         2 / 2 |        2 / 2 |                1 / 2 |  0 / 2 |        0 / 2 |  0 / 2 |
| Auth, session, and token design           |         3 / 3 |        3 / 3 |                2 / 3 |  0 / 3 |        0 / 3 |  0 / 3 |
| Missing preventive controls               |         2 / 3 |        2 / 3 |                2 / 3 |  0 / 3 |        0 / 3 |  0 / 3 |
| Sensitive-data and configuration exposure |         4 / 4 |        4 / 4 |                2 / 4 |  1 / 4 |        0 / 4 |  1 / 4 |

For missing preventive controls, all three agentic runs found #5 arbitrary file upload and #22 missing CSRF protection, but missed #16 missing login rate limiting.

## Tool-Based Reports

CodeQL, Semgrep, and ZAP are scanner-style reports. Their outputs are mapped to the answer key at alert/finding level only.

| Tool metric                                | CodeQL                  | Semgrep Code         | Semgrep Supply Chain               | ZAP frontend + API       |
| ------------------------------------------ | ----------------------- | -------------------- | ---------------------------------- | ------------------------ |
| Outputs                                    | 11 code scanning alerts | 10 code findings     | 10 dependency advisories           | 16 reviewed alert groups |
| Answer-key recall contribution             | 7 / 22 (31.8%)          | 8 / 22 (36.4%)       | 0 / 22                             | 3 / 22 (13.6%)           |
| Extra security surfaces outside answer key | 1                       | 0                    | 10 dependency advisories           | 8 hardening surfaces     |
| Reviewed precision                         | 8 / (8 + 0) = 100.0%    | 8 / (8 + 0) = 100.0% | Not scored as application findings | 11 / (11 + 1) = 91.7%    |
| False discovery rate                       | 0 / (8 + 0) = 0.0%      | 0 / (8 + 0) = 0.0%   | Not scored as application findings | 1 / (11 + 1) = 8.3%      |
| Reachability evidence                      | N/A                     | N/A                  | 2 reachable or always reachable    | N/A                      |

CodeQL covered SQL injection, download path traversal, command injection, SSRF, and plaintext password logging. It also reported cookie `Secure` flag hardening outside the answer key. After duplicate alert grouping, this is 8 reviewed true-positive security surfaces: 7 answer-key surfaces plus 1 extra session-cookie hardening surface.

Semgrep Code covered SQL injection, command injection, SSRF, and three frontend React XSS items. It did not cover download path traversal or plaintext password logging in this export. After duplicate finding grouping, this is 8 reviewed true-positive answer-key surfaces and no extra application security surface.

Semgrep Supply Chain reported dependency risks separately: 10 advisories, including 2 `golang.org/x/net` findings with reachability evidence. These are dependency-risk signals rather than answer-key application vulnerability coverage.

ZAP's combined frontend/API run is scored from the reviewed clean report generated by `zap/clean-zap-combined-report.sh`. The clean report contains 16 application-relevant alert groups and covers 3 answer-key items: SearchPosts SQL injection, command injection in the ping tool, and password-hash exposure in the user response. It also reports 8 response-header or cookie hardening surfaces outside the answer key, 2 weak non-covering 5xx signals, and 1 reviewed false positive (`Format String Error` on registration).

CodeQL, Semgrep, and ZAP produced much smaller reviewed output sets than the agentic runs: 11 CodeQL alerts, 10 Semgrep Code findings, and 16 reviewed ZAP alert groups, compared with 45, 70, and 43 agentic cases. CodeQL and Semgrep coverage is concentrated in localized sink-style issues such as SQL injection, command injection, SSRF, path traversal, password logging, and frontend XSS. ZAP's confirmed coverage is concentrated in externally reachable backend behavior and browser/header hardening. The tool-based reports did not cover most authorization, JWT, CSRF, and missing-control items in this benchmark.

## Agentic Runs

Compared with the tool-based reports above, the agentic runs add analyzer judgment, remediation, delivery planning, and token-cost accounting.

mimo-v2.5-pro and MiniMax M2.7 reached the same case/analyzer answer-key recall: 21 / 22 answer-key vulnerabilities became cases and were confirmed by analyzer judgment. Their shared miss was #16 missing login rate limiting. MiniMax M2.7 has one additional repair-stage miss because the weak JWT secret case was confirmed but not delivered. Doubao Seed 2.0 Lite reached 15 / 22, with misses concentrated in backend authentication, JWT, data exposure, and logging surfaces.

### Case Volume And Review Load

| Volume metric                                           | mimo-v2.5-pro | MiniMax M2.7 | Doubao Seed 2.0 Lite                        |
| ------------------------------------------------------- | ------------: | -----------: | ------------------------------------------- |
| Candidates                                              |            87 |          105 | 49                                          |
| Cases                                                   |            45 |           70 | 43                                          |
| Confirmed cases                                         |            35 |           62 | 43                                          |
| Delivered cases                                         |            34 |           60 | 43                                          |
| Duplicate / defense-in-depth cases after manual review  |             5 |           25 | overlapping duplicates, not fully counted   |
| Non-security / hardening-only cases after manual review |             0 |            4 | 6 non-security, 1 deployment-hardening risk |
| Reviewed false positives                                |             0 |            1 | 3                                           |

MiniMax M2.7 produced the largest case set, including more additional security cases and more duplicate, defense-in-depth, or overlapping cases. Doubao Seed 2.0 Lite produced fewer candidates, but all 43 retained cases proceeded to delivery, including non-security defects, one deployment-hardening risk, and three reviewed false positives.

### Additional Coverage And Reclassification

All three agentic runs found issues outside the answer key. Representative additional true positives and independently reclassified surfaces include:

| Additional issue                                                    | mimo-v2.5-pro                     | MiniMax M2.7                               | Doubao Seed 2.0 Lite              |
| ------------------------------------------------------------------- | --------------------------------- | ------------------------------------------ | --------------------------------- |
| JWT stored in `localStorage`                                        | Found                             | Found                                      | Found                             |
| Upload path traversal via original filename                         | Found                             | Found                                      | Duplicate/upload-hardening case   |
| Vote race condition                                                 | Found                             | Found                                      | Not listed as final additional TP |
| Session cookie missing `Secure` flag                                | Found                             | Found                                      | Not listed as final additional TP |
| No file upload size limit                                           | Found                             | Found                                      | Found                             |
| File download endpoint lacks authorization                          | Found                             | Found                                      | Found                             |
| Missing auth on `AdminDeleteUser`                                   | Not listed as final additional TP | Reviewed FP: route group already protected | Not listed as final additional TP |
| Missing explicit admin authorization in `ListUsers`                 | Not listed as final additional TP | Defense-in-depth / duplicate               | Not listed as final additional TP |
| Missing current-password verification for sensitive profile updates | Not listed as final additional TP | Found                                      | Not listed as final additional TP |
| Vite dependency vulnerability                                       | Not listed as final additional TP | Not listed as final additional TP          | Found                             |
| Network utility endpoints exposed without authentication            | Not listed as final additional TP | Not listed as final additional TP          | Found                             |
| Edit-post IDOR                                                      | Not listed as final additional TP | Found                                      | Found                             |

The additional coverage in MiniMax M2.7 is visible in the delivered-case count and in the manual-review table, and should be read together with the duplicate, defense-in-depth, and non-security-defect counts. Doubao Seed 2.0 Lite also found additional surfaces, while its delivered set included non-security, deployment-hardening, and false-positive cases.

### Delivery Evaluation

| Delivery metric    | mimo-v2.5-pro | MiniMax M2.7 | Doubao Seed 2.0 Lite |
| ------------------ | ------------: | -----------: | -------------------: |
| Ideal deliveries   |             9 |            9 |                    9 |
| Actual deliveries  |            14 |           23 |                   43 |
| Delivery count gap |            +5 |          +14 |                  +34 |

Delivery count gap compares the ideal delivery plan against the actual number of deliveries produced by the run. Lower is better when the actual deliveries still preserve clear review boundaries. mimo-v2.5-pro is closest to the 9-delivery ideal. MiniMax M2.7 produced more deliveries because several security themes remained split despite useful grouping. Doubao Seed 2.0 Lite produced 43 actual deliveries because all retained cases were emitted as single-case artifacts.

For answer-key item #11, mimo-v2.5-pro delivered a fix for weak JWT/admin defaults, MiniMax M2.7 confirmed the weak JWT secret case but did not deliver it, and Doubao Seed 2.0 Lite attempted #11 while leaving the default JWT fallback available outside production mode.

The Doubao Seed 2.0 Lite delivery gap is the clearest integration issue: overlapping XSS, CSRF, file, redirect, SSRF/network-tool, and upload-hardening repairs were not synthesized into reviewable repair groups.

## Cost

Cost is reported only for the agentic runs because CodeQL and Semgrep exports do not include comparable token-usage metrics.

| Cost metric                            | mimo-v2.5-pro | MiniMax M2.7 | Doubao Seed 2.0 Lite |
| -------------------------------------- | ------------: | -----------: | -------------------: |
| Total input tokens                     |    30,813,829 |   36,166,857 |           37,875,904 |
| Total output tokens                    |       867,631 |    1,064,127 |              503,223 |
| Cache-read tokens                      |    28,405,952 |            0 |           17,480,328 |
| Observed cost                          |    $10.691960 |   $12.127009 |            $2.416956 |
| Cache-adjusted cost                    |    $10.691960 |    $4.125246 |            $2.416956 |
| Observed cost per delivered case       |     $0.314469 |    $0.202117 |            $0.056208 |
| Cache-adjusted cost per delivered case |     $0.314469 |    $0.068754 |            $0.056208 |
| Observed cost per delivery             |     $0.763711 |    $0.527261 |            $0.056208 |
| Cache-adjusted cost per delivery       |     $0.763711 |    $0.179359 |            $0.056208 |

The observed MiniMax M2.7 artifacts report `0` cache-read tokens. For cross-run comparison, the cache-adjusted MiniMax estimate applies the mimo-v2.5-pro observed cache ratio to MiniMax input tokens:

```text
mimo cache ratio = 28,405,952 / 30,813,829 = 92.185726%
estimated MiniMax cache-read tokens = 33,340,680
estimated MiniMax uncached input tokens = 2,826,177
cache-adjusted MiniMax cost = $4.125246
```

The cache-adjusted estimate is not an observed billing metric. It is included to normalize the comparison for prompt-cache effects.

## Takeaways

- At case/analyzer level, mimo-v2.5-pro and MiniMax M2.7 covered 21 / 22 answer-key items; Doubao Seed 2.0 Lite covered 15 / 22.
- CodeQL covered 7 / 22 answer-key items, Semgrep Code covered 8 / 22, and ZAP covered 3 / 22.
- CodeQL and Semgrep produced compact scanner-style input sets, while the agentic runs produced larger case sets with more review and deduplication load.
- CodeQL and Semgrep are complementary at sink coverage: CodeQL found Go path traversal and password logging, while Semgrep found frontend React XSS.
- ZAP's OpenAPI-seeded API scan found command injection, search SQL injection, and password-hash exposure, while still missing most authenticated, source/config, CSRF, and multi-step vulnerabilities.
- At final repair-plan level, mimo-v2.5-pro covered 21 / 22 answer-key items, MiniMax M2.7 covered 20 / 22, and Doubao Seed 2.0 Lite covered 15 / 22 with one incomplete repair.
- Delivery count gap was smallest for mimo-v2.5-pro (+5), larger for MiniMax M2.7 (+14), and largest for Doubao Seed 2.0 Lite (+34), where all deliveries were single-case artifacts.
- Reviewed false positives were 0 for mimo-v2.5-pro, 1 for MiniMax M2.7, and 3 for Doubao Seed 2.0 Lite under the README definition.
- Login rate limiting was missed by all reports, suggesting absent cross-cutting controls need explicit discovery support.
