# Repo Full-Scan on WorldPress - Comparison

## Scope

This report compares the WorldPress repository full-scan reports in this directory.

- Benchmark answer key: [worldpress/VULNERABILITIES.md](https://github.com/Agent-AI-Chalmers/worldpress/blob/answer/VULNERABILITIES.md)
- Public target repository: [Agent-AI-Chalmers/worldpress](https://github.com/Agent-AI-Chalmers/worldpress)
- Scanned branch: `main` (`origin/main` at `bbe19d8`)
- Answer-key branch: `answer` (`origin/answer` at `da197dd`)
- Answer-key size: 21 numbered vulnerability items
- Ideal deliveries: 10 reviewer-oriented delivery groups
- Agentic full-scan runs:
  - [mimo-v2.5-pro](./mimo-v2.5-pro.md)
  - [MiniMax M2.7](./minimax-m2.7.md)
  - [Doubao Seed 2.0 Lite](./doubao_seed_2_lite.md)
- Tool-based reports:
  - [CodeQL code scanning alerts](./CodeQL/CodeQL.md)
  - [Semgrep code and supply-chain findings](./Semgrep/Semgrep.md)
  - [OWASP ZAP frontend and API alerts](./zap/zap.md)
- Metric definitions follow [Repository Full-Scan Evaluation Concepts](../README.md).

WorldPress lists 21 numbered vulnerabilities and also labels the unauthenticated preview traversal as `#11b`. This comparison shows `#11b` separately in coverage tables, but treats it as a subcase of path traversal item `#11` for the 21-item denominator, matching the existing tool-report denominator in this directory.

The agentic workflow reports below are based on the concrete local run artifacts under `.agent-workspace/worldpress-repo-scan-*`. The agentic workflow reports include discovery, analyzer judgment, remediation, delivery, and token-cost metrics. CodeQL, Semgrep, and ZAP are scanner-style reports, so they are compared at answer-key detection coverage and reviewed precision; they do not have remediation or delivery metrics.

## Headline Metrics

| Metric                                            | mimo-v2.5-pro                              | MiniMax M2.7                               | Doubao Seed 2.0 Lite                       | CodeQL                 | Semgrep                                 | ZAP                      |
| ------------------------------------------------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------ | ---------------------- | --------------------------------------- | ------------------------ |
| Scanner-style outputs                             | 39 cases                                   | 52 cases                                   | 33 cases                                   | 20 alerts              | 25 findings                             | 12 reviewed alert groups |
| Confirmed cases                                   | 36                                         | 49                                         | 33                                         | N/A                    | N/A                                     | N/A                      |
| Delivered cases                                   | 36                                         | 49                                         | 33                                         | N/A                    | N/A                                     | N/A                      |
| Deliveries                                        | 20                                         | 49                                         | 10                                         | N/A                    | N/A                                     | N/A                      |
| Answer-key recall at case / alert / finding level | 20 / 21 (95.2%)                            | 20 / 21 (95.2%)                            | 17 / 21 (81.0%)                            | 9 / 21 (42.9%)         | 8 / 21 (38.1%)                          | 2 / 21 (9.5%)            |
| Answer-key recall at final repair-plan level      | 20 / 21 (95.2%)                            | 20 / 21 (95.2%)                            | 17 / 21 (81.0%)                            | N/A                    | N/A                                     | N/A                      |
| Answer-key remediation outcome                    | 20 complete, 1 missed                      | 20 complete, 1 missed                      | 17 complete, 4 missed                      | N/A                    | N/A                                     | N/A                      |
| Delivery count gap                                | +10                                        | +39                                        | 0                                          | N/A                    | N/A                                     | N/A                      |
| Reviewed precision                                | 33 / (33 + 0) = 100.0%                     | 30 / (30 + 0) = 100.0%                     | 27 / (27 + 0) = 100.0%                     | 13 / (13 + 0) = 100.0% | 12 / (12 + 0) = 100.0%                  | 10 / (10 + 0) = 100.0%   |
| False discovery rate                              | 0 / (33 + 0) = 0.0%                        | 0 / (30 + 0) = 0.0%                        | 0 / (27 + 0) = 0.0%                        | 0 / (13 + 0) = 0.0%    | 0 / (12 + 0) = 0.0%                     | 0 / (10 + 0) = 0.0%      |
| Extra security surfaces outside answer key        | 13 delivered hardening/additional surfaces | 10 delivered hardening/additional surfaces | 10 delivered hardening/additional surfaces | 4                      | 4 code, plus 13 supply-chain advisories | 8 hardening surfaces     |
| Observed run cost                                 | $8.891914                                  | $6.277521                                  | $1.216244                                  | N/A                    | N/A                                     | N/A                      |
| Cache-adjusted run cost                           | $8.891914                                  | $2.317299                                  | $1.216244                                  | N/A                    | N/A                                     | N/A                      |

Token and cost rows are from `python -m scripts.token_usage.summarize` over the three local run directories, using the CLI's `auto-by-model_id` pricing profile. They are not hand-aggregated report numbers.

## Answer-Key Coverage

For the agentic runs, the table records final repair-plan/remediation status: `Found` means the answer-key item is completely covered by the final repair plan. For CodeQL, Semgrep, and ZAP, the table records scanner-style detection status only because those tools do not produce repairs. `#11b` is shown separately for traceability but remains a subcase of answer-key item `#11` in the 21-item denominator.

| Answer-key item                           | mimo-v2.5-pro | MiniMax M2.7 | Doubao Seed 2.0 Lite | CodeQL | Semgrep Code | ZAP    |
| ----------------------------------------- | ------------- | ------------ | -------------------- | ------ | ------------ | ------ |
| #1 SQL injection (login)                  | Found         | Found        | Found                | Found  | Found        | Found  |
| #2 Open redirect                          | Found         | Found        | Found                | Missed | Missed       | Missed |
| #3 Missing login rate limiting            | Missed        | Missed       | Missed               | Missed | Missed       | Missed |
| #4 Weak JWT secret                        | Found         | Found        | Missed               | Missed | Missed       | Missed |
| #5 IDOR user read                         | Found         | Found        | Missed               | Missed | Missed       | Missed |
| #6 Mass assignment / privilege escalation | Found         | Found        | Missed               | Missed | Missed       | Missed |
| #7 Password hash exposure                 | Found         | Found        | Found                | Missed | Missed       | Missed |
| #8 SQL injection (search)                 | Found         | Found        | Found                | Found  | Found        | Found  |
| #9 Stored XSS in post content             | Found         | Found        | Found                | Missed | Found        | Missed |
| #10 IDOR post edit/delete                 | Found         | Found        | Found                | Missed | Missed       | Missed |
| #11 Path traversal download               | Found         | Found        | Found                | Found  | Missed       | Missed |
| #11b Path traversal preview subcase       | Found         | Found        | Found                | Found  | Missed       | Missed |
| #12 Unrestricted file upload              | Found         | Found        | Found                | Missed | Missed       | Missed |
| #13 Command injection                     | Found         | Found        | Found                | Found  | Found        | Missed |
| #14 SSRF                                  | Found         | Found        | Found                | Found  | Found        | Missed |
| #15 Hardcoded credential leakage          | Found         | Found        | Found                | Missed | Missed       | Missed |
| #16 Insecure deserialization              | Found         | Found        | Found                | Found  | Found        | Missed |
| #17 XXE                                   | Found         | Found        | Found                | Found  | Found        | Missed |
| #18 Full stack trace exposure             | Found         | Found        | Found                | Found  | Missed       | Missed |
| #19 Header-based admin bypass             | Found         | Found        | Found                | Missed | Missed       | Missed |
| #20 Stored XSS in comments                | Found         | Found        | Found                | Missed | Missed       | Missed |
| #21 Reflected XSS in comment author       | Found         | Found        | Found                | Found  | Found        | Missed |

At case/analyzer and final-repair levels, mimo-v2.5-pro and MiniMax M2.7 each covered 20 / 21 answer-key items. Doubao Seed 2.0 Lite covered 17 / 21. The shared miss across all agentic runs was #3, missing login rate limiting.

### Issue Category Coverage

| Category                                  | mimo-v2.5-pro | MiniMax M2.7 | Doubao Seed 2.0 Lite | CodeQL | Semgrep Code |   ZAP |
| ----------------------------------------- | ------------: | -----------: | -------------------: | -----: | -----------: | ----: |
| Injection, parser, file, and OS sinks     |         8 / 8 |        8 / 8 |                8 / 8 |  7 / 8 |        6 / 8 | 2 / 8 |
| Access-control and account-state logic    |         4 / 4 |        4 / 4 |                2 / 4 |  0 / 4 |        0 / 4 | 0 / 4 |
| Auth, token, and missing controls         |         2 / 3 |        2 / 3 |                1 / 3 |  0 / 3 |        0 / 3 | 0 / 3 |
| Sensitive-data and configuration exposure |         3 / 3 |        3 / 3 |                3 / 3 |  1 / 3 |        0 / 3 | 0 / 3 |
| Rendering/XSS                             |         3 / 3 |        3 / 3 |                3 / 3 |  1 / 3 |        2 / 3 | 0 / 3 |

CodeQL, Semgrep, and ZAP mainly cover localized sink behavior. The agentic runs cover authorization, JWT/configuration, and cross-file application logic more effectively. Login rate limiting remained a blind spot for all runs and tools.

## Tool-Based Reports

CodeQL, Semgrep, and ZAP are scanner-style reports. Their outputs are mapped to the answer key at alert/finding level only.

| Tool metric                                | CodeQL                  | Semgrep Code           | Semgrep Supply Chain               | ZAP frontend + API       |
| ------------------------------------------ | ----------------------- | ---------------------- | ---------------------------------- | ------------------------ |
| Outputs                                    | 20 code scanning alerts | 25 code findings       | 13 dependency advisories           | 12 reviewed alert groups |
| Answer-key recall contribution             | 9 / 21 (42.9%)          | 8 / 21 (38.1%)         | 0 / 21                             | 2 / 21 (9.5%)            |
| Extra security surfaces outside answer key | 4                       | 4                      | 13 dependency advisories           | 8 hardening surfaces     |
| Reviewed precision                         | 13 / (13 + 0) = 100.0%  | 12 / (12 + 0) = 100.0% | Not scored as application findings | 10 / (10 + 0) = 100.0%   |
| False discovery rate                       | 0 / (13 + 0) = 0.0%     | 0 / (12 + 0) = 0.0%    | Not scored as application findings | 0 / (10 + 0) = 0.0%      |

CodeQL and Semgrep are strongest on SQL injection, command injection, SSRF, parser risks, and some XSS. CodeQL also produced four stack-trace-rule alerts where the route returned exception messages rather than full tracebacks. These alerts are treated as non-covering related information-disclosure signals: they do not cover the full-stack-trace answer-key item, but they are not counted as reviewed false positives. ZAP found externally reachable SQL injection behavior in login and search, plus response/header hardening signals, but missed most source/config, JWT, authorization, parser, and stored-rendering issues. Its precision row counts the two answer-key SQL injection surfaces and eight reviewed hardening surfaces as true positives, while excluding the retained weak non-covering 5xx group from the precision denominator.

## Agentic Runs

Compared with the tool-based reports above, the agentic runs add analyzer judgment, remediation, delivery planning, and token-cost accounting.

mimo-v2.5-pro produced 85 candidates, 39 cases, 36 delivered cases, and 20 deliveries. It missed only login rate limiting and had moderate delivery fragmentation.

MiniMax M2.7 produced the largest case set: 94 candidates, 52 cases, 49 delivered cases, and 49 deliveries. It matched mimo on answer-key coverage but did not consolidate deliveries: every publishable case became a single delivery.

Doubao Seed 2.0 Lite produced 60 candidates, 33 cases, 33 delivered cases, and 10 deliveries. It had the cleanest delivery count relative to the 10-delivery ideal plan, but it missed weak JWT secret, user-read IDOR, user-profile mass assignment, and login rate limiting.

### Case Volume And Review Load

| Volume metric         | mimo-v2.5-pro | MiniMax M2.7 | Doubao Seed 2.0 Lite |
| --------------------- | ------------: | -----------: | -------------------: |
| Candidates            |            85 |           94 |                   60 |
| Suppressed candidates |            26 |           33 |                    8 |
| Cases                 |            39 |           52 |                   33 |
| Confirmed cases       |            36 |           49 |                   33 |
| Delivered cases       |            36 |           49 |                   33 |
| Non-delivered cases   |             3 |            3 |                    0 |
| Deliveries            |            20 |           49 |                   10 |

### Additional Coverage And Reclassification

All three agentic runs found issues outside the answer key. The table below summarizes how manual review reclassified final cases beyond benchmark recall.

| Review-load category                                                       | mimo-v2.5-pro | MiniMax M2.7 | Doubao Seed 2.0 Lite |
| -------------------------------------------------------------------------- | ------------: | -----------: | -------------------: |
| Delivered cases covering answer-key items, including duplicates/subcases   |            22 |           32 |                   18 |
| Delivered additional true-risk or hardening surfaces outside answer key    |            13 |           10 |                   10 |
| Delivered duplicates, non-security, frontend-only, or product observations |             1 |            7 |                    5 |
| Blocked cases not counted as delivered coverage                            |             3 |            3 |                    0 |

Representative additional surfaces include JWT `alg:none`, MD5 password hashing, `localStorage` token exposure, Flask debug mode, permissive CORS, media deletion authorization, CI/workflow hardening, dependency hash verification, and settings allowlist hardening. The detailed case-by-case excluded review-load calls are in the three model reports.

### Delivery Evaluation

| Delivery metric    | mimo-v2.5-pro | MiniMax M2.7 | Doubao Seed 2.0 Lite |
| ------------------ | ------------: | -----------: | -------------------: |
| Ideal deliveries   |            10 |           10 |                   10 |
| Actual deliveries  |            20 |           49 |                   10 |
| Delivery count gap |           +10 |          +39 |                    0 |

Doubao matched the ideal delivery count but missed more answer-key items. MiniMax had broad coverage but the least reviewable packaging. mimo sits between them: broad coverage with some fragmentation.

## Cost

Cost is reported only for the agentic runs because CodeQL, Semgrep, and ZAP exports do not include comparable token-usage metrics.

| Cost metric                            | mimo-v2.5-pro | MiniMax M2.7 | Doubao Seed 2.0 Lite |
| -------------------------------------- | ------------: | -----------: | -------------------: |
| Total input tokens                     |    21,683,361 |   18,099,730 |           18,849,504 |
| Total output tokens                    |     1,007,651 |      706,335 |              303,553 |
| Cache-read tokens                      |    19,768,000 |            0 |            8,904,088 |
| Observed cost                          |     $8.891914 |    $6.277521 |            $1.216244 |
| Cache-adjusted cost                    |     $8.891914 |    $2.317299 |            $1.216244 |
| Observed cost per delivered case       |      $0.24700 |     $0.12811 |             $0.03686 |
| Cache-adjusted cost per delivered case |      $0.24700 |     $0.04729 |             $0.03686 |
| Observed cost per delivery             |      $0.44460 |     $0.12811 |             $0.12162 |
| Cache-adjusted cost per delivery       |      $0.44460 |     $0.04729 |             $0.12162 |

The observed MiniMax M2.7 artifacts report `0` cache-read tokens. For cross-run comparison, the cache-adjusted MiniMax estimate applies the mimo-v2.5-pro observed cache ratio to MiniMax input tokens:

```text
mimo cache ratio = 19,768,000 / 21,683,361 = 91.166678%
estimated MiniMax cache-read tokens = 16,500,923
estimated MiniMax uncached input tokens = 1,598,807
cache-adjusted MiniMax cost = $2.317299
```

The cache-adjusted estimate is not an observed billing metric. It is included to normalize the comparison for prompt-cache effects.

## Takeaways

- WorldPress has 21 numbered answer-key items, with `#11b` tracked as a subcase of path traversal.
- mimo-v2.5-pro and MiniMax M2.7 both reached 20 / 21 final repair-plan coverage.
- Doubao Seed 2.0 Lite had the best delivery count alignment, but lower answer-key coverage at 17 / 21.
- MiniMax M2.7 had the largest reviewability issue: 49 actual deliveries for 10 ideal delivery groups.
- All agentic runs missed login rate limiting.
- Tool-style scanners were useful for localized sink findings but missed most authorization, token, configuration, and workflow-level issues.
