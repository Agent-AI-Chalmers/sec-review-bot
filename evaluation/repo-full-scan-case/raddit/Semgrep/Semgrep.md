# Semgrep Findings

## Source

This report uses the Semgrep Platform Code findings export:

[Semgrep_Code_Findings_2026_05_02.csv](Semgrep_Code_Findings_2026_05_02.csv)

It also references the Semgrep Platform Supply Chain findings export:

[Semgrep_Supply_Chain_Findings_2026_05_02.csv](Semgrep_Supply_Chain_Findings_2026_05_02.csv)

## Summary

Semgrep produced 10 code findings. Manual mapping to the 22-item Raddit answer key shows 8 covered answer-key vulnerabilities and 14 not covered.

```text
Answer-key recall = 8 / 22 = 36.4%
```

The 10 findings correspond to 8 answer-key items because some findings are duplicate or overlapping locations within the same vulnerability surface. Semgrep did not report an extra security surface outside the answer key in this export.

| Measure                                     | Result               |
| ------------------------------------------- | -------------------- |
| Semgrep code findings                       | 10                   |
| Answer-key items covered                    | 8 / 22 (36.4%)       |
| Answer-key items not covered                | 14 / 22 (63.6%)      |
| Extra security surfaces outside answer key  | 0                    |
| Reviewed precision after duplicate grouping | 8 / (8 + 0) = 100.0% |

## Mapping to Answer

|   # | Answer-key vulnerability                    | Semgrep coverage | Evidence                                                                                                                                   |
| --: | ------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
|   1 | Login SQL injection                         | Covered          | `772939741`, `go.lang.security.audit.database.string-formatted-query`, `backend/handlers/auth.go:60`                                       |
|   2 | SearchPosts SQL injection                   | Covered          | `772939738`, `go.lang.security.audit.database.string-formatted-query`, `backend/handlers/posts.go:67`                                      |
|   3 | ListPosts SQL injection                     | Covered          | `772939740`, `772939739`, `go.lang.security.audit.database.string-formatted-query`, `backend/handlers/posts.go:25/30`                      |
|   4 | File download path traversal                | Not covered      | No file path traversal alert.                                                                                                              |
|   5 | Arbitrary file upload                       | Not covered      | No upload type or extension validation alert.                                                                                              |
|   6 | Command injection in ping tool              | Covered          | `772939744`, `go.gin.command-injection`; `772939742`, `go.lang.security.audit.dangerous-exec-command`; both at `backend/utils/utils.go:22` |
|   7 | SSRF in URL preview                         | Covered          | `772939743`, `go.gin.ssrf.gin-tainted-url-host`, `backend/handlers/posts.go:238`                                                           |
|   8 | IDOR delete post                            | Not covered      | No authorization or ownership alert.                                                                                                       |
|   9 | Password hash exposure in user response     | Not covered      | No response data exposure alert.                                                                                                           |
|  10 | User-controllable role privilege escalation | Not covered      | No mass-assignment or role-update alert.                                                                                                   |
|  11 | Weak JWT secret                             | Not covered      | No hardcoded JWT secret alert.                                                                                                             |
|  12 | JWT `alg:none` bypass                       | Not covered      | No JWT parser alert.                                                                                                                       |
|  13 | Admin debug information disclosure          | Not covered      | No debug secret exposure alert.                                                                                                            |
|  14 | Hardcoded admin credentials                 | Not covered      | No hardcoded admin credential alert.                                                                                                       |
|  15 | Plaintext password logging on failed login  | Not covered      | No clear-text password logging alert in this export.                                                                                       |
|  16 | Missing rate limiting on login              | Not covered      | No rate-limiting alert.                                                                                                                    |
|  17 | Open redirect in login                      | Not covered      | No redirect validation alert.                                                                                                              |
|  18 | Stored XSS in post content                  | Covered          | `772939735`, `typescript.react.security.audit.react-dangerouslysetinnerhtml`, `frontend/src/components/PostCard.jsx:64`                    |
|  19 | Stored XSS in comment content               | Covered          | `772939736`, `typescript.react.security.audit.react-dangerouslysetinnerhtml`, `frontend/src/components/Comment.jsx:48`                     |
|  20 | Reflected XSS in search query               | Covered          | `772939737`, `typescript.react.react-dangerouslysetinnerhtml-url`, `frontend/src/pages/Home.jsx:57`                                        |
|  21 | Stored XSS in profile bio                   | Not covered      | No profile bio rendering alert.                                                                                                            |
|  22 | Missing CSRF protection                     | Not covered      | No CSRF alert.                                                                                                                             |

## Duplicate Or Overlapping Findings

|                   Finding | Rule                                                     | Location                          | Manual review                                                    |
| ------------------------: | -------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------- |
|               `772939742` | `go.lang.security.audit.dangerous-exec-command`          | `backend/utils/utils.go:22`       | Duplicate of the stronger command-injection finding `772939744`. |
| `772939739` / `772939740` | `go.lang.security.audit.database.string-formatted-query` | `backend/handlers/posts.go:25/30` | Two branches of the same `ListPosts` SQL injection surface.      |

## False Positive Review

Manual review found no false positives among the 10 Semgrep code findings. After duplicate finding grouping, the reviewed precision numerator is 8 true-positive answer-key security surfaces and 0 extra application security surfaces.

The duplicate or overlapping findings above are real detections that point to already-counted vulnerability surfaces. They reduce the number of unique answer-key vulnerabilities covered, but they are not false positives.

## Supply Chain Findings

Semgrep also produced 10 supply-chain findings. These are not counted toward the 22-item Raddit answer-key recall because the answer key focuses on manually injected application vulnerabilities. They are reported separately as dependency-risk coverage.

| Measure                          | Result |
| -------------------------------- | -----: |
| Supply-chain findings            |     10 |
| High severity                    |      1 |
| Medium severity                  |      9 |
| Reachable or always reachable    |      2 |
| No reachability analysis         |      8 |
| Direct dependencies              |      3 |
| Transitive dependencies          |      7 |
| Answer-key coverage contribution | 0 / 22 |

|     Finding | Dependency                   | Version  | Severity | Reachability             | Transitivity | Advisory              |
| ----------: | ---------------------------- | -------- | -------- | ------------------------ | ------------ | --------------------- |
| `772939754` | `golang.org/x/net`           | `0.16.0` | High     | Always Reachable         | Transitive   | `CVE-2023-39325`      |
| `772939753` | `golang.org/x/net`           | `0.16.0` | Medium   | Reachable                | Transitive   | `CVE-2023-45288`      |
| `772939752` | `golang.org/x/net`           | `0.16.0` | Medium   | No Reachability Analysis | Transitive   | `CVE-2023-44487`      |
| `772939751` | `google.golang.org/protobuf` | `1.31.0` | Medium   | No Reachability Analysis | Transitive   | `CVE-2024-24786`      |
| `772939750` | `esbuild`                    | `0.21.5` | Medium   | No Reachability Analysis | Transitive   | `GHSA-67mh-4wv8-2f99` |
| `772939749` | `golang.org/x/net`           | `0.16.0` | Medium   | No Reachability Analysis | Transitive   | `CVE-2025-22870`      |
| `772939748` | `golang.org/x/net`           | `0.16.0` | Medium   | No Reachability Analysis | Transitive   | `CVE-2025-22872`      |
| `772939747` | `golang.org/x/crypto`        | `0.18.0` | Medium   | No Reachability Analysis | Direct       | `CVE-2025-47914`      |
| `772939746` | `golang.org/x/crypto`        | `0.18.0` | Medium   | No Reachability Analysis | Direct       | `CVE-2025-58181`      |
| `772939745` | `vite`                       | `5.4.21` | Medium   | No Reachability Analysis | Direct       | `CVE-2026-39365`      |

The two findings with reachability evidence are both `golang.org/x/net` resource-consumption issues. The remaining eight findings are dependency hygiene signals that need separate reachability and deployment review before being treated as application vulnerabilities.

## Interpretation

Semgrep Code covers SQL injection, command injection, SSRF, and several frontend React XSS sinks in this export. It does not cover most repository-level or application-design issues in the Raddit answer key, including authorization/IDOR, JWT design flaws, broad CSRF, rate limiting, upload validation, response-data exposure, hardcoded credentials, and plaintext password logging. Semgrep Supply Chain adds dependency-risk visibility, especially around `golang.org/x/net`, but those advisories are evaluated separately from answer-key application vulnerability recall.
