# Repo Full-Scan on Book Shop - Comparison

## Scope

This report compares the Book Shop repository full-scan reports in this directory.

- Benchmark answer key: [book_shop/vulnerabilities_report.md](https://github.com/Agent-AI-Chalmers/book_shop/blob/answer/vulnerabilities_report.md)
- Public target repository: [Agent-AI-Chalmers/book_shop](https://github.com/Agent-AI-Chalmers/book_shop)
- Scanned branch: `main` (`origin/main` at `4139a35`)
- Answer-key branch: `answer` (`origin/answer` at `0fa3269`)
- Answer-key size: 19 vulnerability items
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

| Metric                                            | mimo-v2.5-pro                               | MiniMax M2.7                        | Doubao Seed 2.0 Lite                                 | CodeQL               | Semgrep                                | ZAP                      |
| ------------------------------------------------- | ------------------------------------------- | ----------------------------------- | ---------------------------------------------------- | -------------------- | -------------------------------------- | ------------------------ |
| Scanner-style outputs                             | 42 cases                                    | 71 cases                            | 75 cases                                             | 4 alerts             | 12 findings                            | 17 reviewed alert groups |
| Confirmed cases                                   | 40                                          | 61                                  | 74                                                   | N/A                  | N/A                                    | N/A                      |
| Delivered cases                                   | 39                                          | 61                                  | 73                                                   | N/A                  | N/A                                    | N/A                      |
| Deliveries                                        | 22                                          | 53                                  | 44                                                   | N/A                  | N/A                                    | N/A                      |
| Answer-key recall at case / alert / finding level | 19 / 19 (100.0%)                            | 17 / 19 (89.5%)                     | 18 / 19 (94.7%)                                      | 1 / 19 (5.3%)        | 3 / 19 (15.8%)                         | 1 / 19 (5.3%)            |
| Answer-key recall at analyzer level               | 19 / 19 (100.0%)                            | 17 / 19 (89.5%)                     | 17 / 19 (89.5%)                                      | N/A                  | N/A                                    | N/A                      |
| Answer-key recall at final repair-plan level      | 19 / 19 (100.0%)                            | 17 / 19 (89.5%)                     | 13 / 19 (68.4%)                                      | N/A                  | N/A                                    | N/A                      |
| Answer-key remediation outcome                    | 19 complete                                 | 16 complete, 1 incomplete, 2 missed | 9 complete, 4 incomplete, 6 missed                   | N/A                  | N/A                                    | N/A                      |
| Delivery count gap                                | +13                                         | +44                                 | +35                                                  | N/A                  | N/A                                    | N/A                      |
| Reviewed precision                                | 27 / (27 + 0) = 100.0%                      | 57 / (57 + 0) = 100.0%              | 70 / (70 + 0) = 100.0%                               | 2 / (2 + 0) = 100.0% | 6 / (6 + 0) = 100.0%                   | 12 / (12 + 0) = 100.0%   |
| False discovery rate                              | 0 / (27 + 0) = 0.0%                         | 0 / (57 + 0) = 0.0%                 | 0 / (70 + 0) = 0.0%                                  | 0 / (2 + 0) = 0.0%   | 0 / (6 + 0) = 0.0%                     | 0 / (12 + 0) = 0.0%      |
| Extra security surfaces outside answer key        | 8 additional TP plus 3 overlapping surfaces | many additional hardening surfaces  | valid hardening surfaces plus non-answer-key defects | 1                    | 3 code, plus 4 supply-chain advisories | 11 hardening surfaces    |
| Observed run cost                                 | $9.835646                                   | $8.280616                           | $3.088899                                            | N/A                  | N/A                                    | N/A                      |

## Answer-Key Coverage

All six reports are mapped to the same 19-item Book Shop answer key.

For the agentic runs, the table records final repair-plan/remediation status: `Found` means the answer-key item is completely covered by the final repair plan, while `Incomplete` means a relevant case or repair exists but does not cover the full answer-key scope. For CodeQL, Semgrep, and ZAP, the table records scanner-style detection status only because those tools do not produce repairs.

| Answer-key item                                       | mimo-v2.5-pro    | MiniMax M2.7 | Doubao Seed 2.0 Lite | CodeQL | Semgrep Code | ZAP    |
| ----------------------------------------------------- | ---------------- | ------------ | -------------------- | ------ | ------------ | ------ |
| #1 SQL injection (search/login/register)              | Found            | Found        | Incomplete           | Missed | Missed       | Found  |
| #2 JWT bypass (alg:none + weak secret)                | Found            | Found        | Incomplete           | Missed | Missed       | Missed |
| #3 Asset path traversal                               | Found            | Found        | Found                | Missed | Found        | Missed |
| #4 IDOR (order history + review deletion)             | Found            | Incomplete   | Incomplete           | Missed | Missed       | Missed |
| #5 Client-controlled checkout total / price tampering | Found            | Found        | Missed               | Missed | Missed       | Missed |
| #6 Plaintext password storage                         | Found            | Found        | Found                | Missed | Missed       | Missed |
| #7 Stored XSS in reviews                              | Found            | Found        | Found                | Missed | Missed       | Missed |
| #8 Reflected XSS in search query                      | Found            | Found        | Missed               | Missed | Missed       | Missed |
| #9 Profile mass assignment / privilege escalation     | Found            | Found        | Missed               | Missed | Missed       | Missed |
| #10 CSRF via cookie-authenticated profile update      | Found indirectly | Missed       | Incomplete           | Missed | Missed       | Missed |
| #11 Login open redirect                               | Found            | Found        | Missed               | Missed | Missed       | Missed |
| #12 Ineffective login rate limiting                   | Found            | Found        | Found                | Missed | Missed       | Missed |
| #13 Race condition in balance updates                 | Found            | Found        | Missed               | Missed | Missed       | Missed |
| #14 Sensitive data exposure                           | Found            | Found        | Found                | Missed | Missed       | Missed |
| #15 Command injection in admin export                 | Found            | Found        | Found                | Found  | Missed       | Missed |
| #16 Unrestricted avatar upload                        | Found            | Found        | Found                | Missed | Missed       | Missed |
| #17 Second-order SQL injection in admin reports       | Found            | Missed       | Missed               | Missed | Missed       | Missed |
| #18 Directory listing / log file disclosure           | Found            | Found        | Found                | Missed | Found        | Missed |
| #19 XXE in XML import                                 | Found            | Found        | Found                | Missed | Missed       | Missed |

At scanner-style case level, mimo-v2.5-pro covered 19 / 19 answer-key items, MiniMax M2.7 surfaced 17 / 19, and Doubao Seed 2.0 Lite surfaced 18 / 19. The final repair-plan table applies the stricter remediation outcome: MiniMax has 16 complete, 1 incomplete, and 2 missed items, while Doubao has 9 complete, 4 incomplete, and 6 missed items.

### Issue Category Coverage

The Book Shop answer-key category taxonomy is defined in [book_shop/vulnerabilities_report.md](https://github.com/Agent-AI-Chalmers/book_shop/blob/answer/vulnerabilities_report.md). CodeQL, Semgrep, and ZAP mainly cover filesystem, command, or externally reachable sink signals, while the agentic runs cover more repository-level logic and application-design flaws.

| Category                                   | mimo-v2.5-pro | MiniMax M2.7 | Doubao Seed 2.0 Lite | CodeQL | Semgrep Code |   ZAP |
| ------------------------------------------ | ------------: | -----------: | -------------------: | -----: | -----------: | ----: |
| Injection and parser sinks                 |         5 / 5 |        4 / 5 |                4 / 5 |  1 / 5 |        0 / 5 | 1 / 5 |
| File and path handling                     |         3 / 3 |        3 / 3 |                3 / 3 |  0 / 3 |        3 / 3 | 0 / 3 |
| Authorization and account-state logic      |         3 / 3 |        3 / 3 |                1 / 3 |  0 / 3 |        0 / 3 | 0 / 3 |
| Auth, session, token, and missing controls |         4 / 4 |        3 / 4 |                3 / 4 |  0 / 4 |        0 / 4 | 0 / 4 |
| Rendering and sensitive-data exposure      |         4 / 4 |        4 / 4 |                3 / 4 |  0 / 4 |        0 / 4 | 0 / 4 |

## Tool-Based Reports

CodeQL, Semgrep, and ZAP are scanner-style reports. Their outputs are mapped to the answer key at alert/finding level only.

| Tool metric                                | CodeQL                 | Semgrep Code         | Semgrep Supply Chain               | ZAP frontend + API       |
| ------------------------------------------ | ---------------------- | -------------------- | ---------------------------------- | ------------------------ |
| Outputs                                    | 4 code scanning alerts | 12 code findings     | 4 dependency advisories            | 17 reviewed alert groups |
| Answer-key recall contribution             | 1 / 19 (5.3%)          | 3 / 19 (15.8%)       | 0 / 19                             | 1 / 19 (5.3%)            |
| Extra security surfaces outside answer key | 1                      | 3                    | 4 dependency advisories            | 11 hardening surfaces    |
| Reviewed precision                         | 2 / (2 + 0) = 100.0%   | 6 / (6 + 0) = 100.0% | Not scored as application findings | 12 / (12 + 0) = 100.0%   |
| False discovery rate                       | 0 / (2 + 0) = 0.0%     | 0 / (6 + 0) = 0.0%   | Not scored as application findings | 0 / (12 + 0) = 0.0%      |
| Reachability evidence                      | N/A                    | N/A                  | no reachability analysis           | N/A                      |

CodeQL covered the admin export command-injection item and also reported an extra admin export path traversal surface. It missed SQL injection, JWT flaws, asset traversal, IDOR, price tampering, plaintext password storage, XSS, mass assignment, CSRF, open redirect, rate limiting, balance races, sensitive data exposure, unrestricted upload, second-order SQL, log disclosure, and XXE.

Semgrep Code directly covered three file/path answer-key items: asset traversal, avatar upload filename traversal, and admin log directory/file traversal. It also reported additional admin export path traversal and dynamic-regex hardening in the custom XML parser. These findings are useful, but they do not cover most of the benchmark's logic, auth, token, rendering, and data-exposure items.

Semgrep Supply Chain reported four dependency advisories. These are dependency-risk signals rather than answer-key application vulnerability coverage.

ZAP's combined frontend/API run covered one answer-key item: SQL injection in the book search endpoint. It also reported response-header, cookie, and scanner-context hardening surfaces outside the answer key. The retained 5xx and sensitive-ID-in-URL signals are useful context, but they do not prove additional answer-key coverage without exploit-specific evidence.

## Agentic Runs

Compared with the tool-based reports above, the agentic runs add analyzer judgment, remediation, delivery planning, and token-cost accounting.

mimo-v2.5-pro had the strongest end-to-end answer-key coverage: all 19 items were represented, confirmed, and repaired. MiniMax M2.7 had broad vulnerability coverage, but missed the explicit CSRF/profile-update item and the second-order SQL item, and left ownership coverage partially complete. Doubao Seed 2.0 Lite surfaced many relevant issues, and its final repair coverage stopped at 13 / 19 covered or partially covered items.

### Case Volume And Review Load

| Volume metric       | mimo-v2.5-pro | MiniMax M2.7 | Doubao Seed 2.0 Lite |
| ------------------- | ------------: | -----------: | -------------------: |
| Candidates          |           119 |          136 |                  103 |
| Cases               |            42 |           71 |                   75 |
| Confirmed cases     |            40 |           61 |                   74 |
| Delivered cases     |            39 |           61 |                   73 |
| Non-delivered cases |             3 |           10 |                    2 |
| Deliveries          |            22 |           53 |                   44 |

MiniMax M2.7 produced the largest delivered case set and the largest delivery set. Doubao Seed 2.0 Lite produced the most cases and delivered most of them, but its repair set still fragmented into many more deliveries than the ideal plan.

### Additional Coverage And Reclassification

All three agentic runs found issues outside the answer key. Representative additional true positives and hardening surfaces include:

| Additional issue                                 | mimo-v2.5-pro       | MiniMax M2.7 | Doubao Seed 2.0 Lite |
| ------------------------------------------------ | ------------------- | ------------ | -------------------- |
| JWT token or user data stored in `localStorage`  | Found               | Found        | Found                |
| Admin export path traversal                      | Found               | Found        | Found                |
| Admin log path traversal                         | Found               | Found        | Partially found      |
| Avatar upload filename/path hardening            | Found               | Found        | Found                |
| Session cookie missing `httpOnly` / secure flags | Found               | Found        | Found                |
| Sensitive logs or stack traces                   | Found               | Found        | Found                |
| Workflow or CI hardening                         | Not a main final TP | Found        | Found                |
| Password strength or client validation defects   | Not a main final TP | Found        | Found                |

These extra findings should be read as review-load context. Some are valid security surfaces, but they are not substitutes for missing answer-key repairs.

Manual review found 4 non-security, frontend-only, or product-defect delivered observations in the MiniMax M2.7 run and 3 in the Doubao Seed 2.0 Lite run. For MiniMax, these were URL-length/sensitive-data filtering for the search box, seed ID uniqueness, hardcoded profile-form defaults, and client-side-only profile field validation. For Doubao, these were password matching checked only client-side, missing `reviewId` type validation without an authorization impact, and floating-point monetary storage. They are review-load context and are excluded from reviewed precision.

### Delivery Evaluation

| Delivery metric    | mimo-v2.5-pro | MiniMax M2.7 | Doubao Seed 2.0 Lite |
| ------------------ | ------------: | -----------: | -------------------: |
| Ideal deliveries   |             9 |            9 |                    9 |
| Actual deliveries  |            22 |           53 |                   44 |
| Delivery count gap |           +13 |          +44 |                  +35 |

Delivery count gap compares the ideal delivery plan against the actual number of deliveries produced by the run. Lower is not always better by itself: it must be read alongside final repair coverage.

mimo-v2.5-pro produced complete answer-key repairs, but still split several ideal delivery themes across 22 actual artifacts. MiniMax M2.7 delivered many more individual patches, producing the largest delivery count gap. Doubao Seed 2.0 Lite reached most cases, but its final repair plan still spreads across 44 deliveries and leaves the answer-key coverage at 13 / 19.

## Cost

Cost is reported only for the agentic runs because CodeQL, Semgrep, and ZAP exports do not include comparable token-usage metrics.

| Cost metric                      | mimo-v2.5-pro | MiniMax M2.7 | Doubao Seed 2.0 Lite |
| -------------------------------- | ------------: | -----------: | -------------------: |
| Total input tokens               |    26,997,095 |   23,974,168 |           51,699,829 |
| Total output tokens              |       926,591 |      906,971 |              705,490 |
| Cache-read tokens                |    24,926,528 |            0 |           26,916,600 |
| Observed cost                    |     $9.835646 |    $8.280616 |            $3.088899 |
| Observed cost per delivered case |     $0.252196 |    $0.135748 |            $0.042314 |
| Observed cost per delivery       |     $0.447075 |    $0.156238 |            $0.070202 |

The observed MiniMax M2.7 artifacts report `0` cache-read tokens. This table reports observed artifact costs only; it does not apply a cache-adjusted estimate.

## Takeaways

- Book Shop has 19 answer-key items and 9 ideal deliveries.
- mimo-v2.5-pro had the strongest end-to-end result: 19 / 19 final repair-plan coverage, with a delivery count gap of +13.
- MiniMax M2.7 had broad case and repair coverage, but produced 53 deliveries for the 9-delivery ideal plan and missed the explicit CSRF/profile-update item and second-order SQL.
- Doubao Seed 2.0 Lite surfaced many real issues, and 73 / 75 cases reached delivery; its large delivery count gap is caused by fragmentation, while its lower final answer-key coverage reflects separate repair-completeness misses.
- CodeQL, Semgrep, and ZAP were compact and precise, but narrow: CodeQL covered 1 / 19 answer-key items, Semgrep covered 3 / 19, and ZAP covered 1 / 19.
- The hardest Book Shop items for tool-style scanners are the repository-level and design-level issues: JWT design, IDOR, business logic, plaintext password storage, mass assignment, CSRF, rate limiting, balance races, sensitive response minimization, and second-order SQL.
