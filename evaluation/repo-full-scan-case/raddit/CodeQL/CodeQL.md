# CodeQL Code Scanning Alerts

## Fetch From GitHub

```bash
set -euo pipefail

# cd raddit

OWNER=$(gh repo view --json owner -q '.owner.login')
REPO=$(gh repo view --json name -q '.name')

# Set this to the directory where code-scanning-alerts.json should be written.
OUT=...

mkdir -p "$OUT"

gh api --paginate \
  "/repos/$OWNER/$REPO/code-scanning/alerts?state=all&per_page=100" \
  > "$OUT/code-scanning-alerts.json"
```

[code-scanning-alerts.json](code-scanning-alerts.json)

## Summary

GitHub CodeQL produced 11 code scanning alerts. Manual mapping to the 22-item Raddit answer key shows 7 covered answer-key vulnerabilities and 15 not covered; answer-key recall is 7 / 22 = 31.8%.

The 11 alerts correspond to 7 answer-key items because several alerts are duplicate locations within the same vulnerability surface. CodeQL also reported one extra security hardening surface outside the answer key: JWT session cookies missing the `Secure` flag.

| Measure                                     | Result               |
| ------------------------------------------- | -------------------- |
| Code scanning alerts                        | 11                   |
| Answer-key recall                           | 7 / 22 (31.8%)       |
| Answer-key items not covered                | 15 / 22 (68.2%)      |
| Extra security surfaces outside answer key  | 1                    |
| Reviewed precision after duplicate grouping | 8 / (8 + 0) = 100.0% |

## Mapping to Answer

|   # | Answer-key vulnerability                    | CodeQL coverage | Evidence                                                                 |
| --: | ------------------------------------------- | --------------- | ------------------------------------------------------------------------ |
|   1 | Login SQL injection                         | Covered         | `alert 9`, `go/sql-injection`, `backend/handlers/auth.go:61`             |
|   2 | SearchPosts SQL injection                   | Covered         | `alert 11`, `go/sql-injection`, `backend/handlers/posts.go:69`           |
|   3 | ListPosts SQL injection                     | Covered         | `alert 10`, `go/sql-injection`, `backend/handlers/posts.go:36`           |
|   4 | File download path traversal                | Covered         | `alerts 7, 8`, `go/path-injection`, `backend/handlers/files.go:65/70`    |
|   5 | Arbitrary file upload                       | Not covered     | No upload type or extension validation alert.                            |
|   6 | Command injection in ping tool              | Covered         | `alert 1`, `go/command-injection`, `backend/utils/utils.go:22`           |
|   7 | SSRF in URL preview                         | Covered         | `alert 6`, `go/request-forgery`, `backend/handlers/posts.go:238`         |
|   8 | IDOR delete post                            | Not covered     | No authorization or ownership alert.                                     |
|   9 | Password hash exposure in user response     | Not covered     | No response data exposure alert.                                         |
|  10 | User-controllable role privilege escalation | Not covered     | No mass-assignment or role-update alert.                                 |
|  11 | Weak JWT secret                             | Not covered     | No hardcoded JWT secret alert.                                           |
|  12 | JWT `alg:none` bypass                       | Not covered     | No JWT parser alert.                                                     |
|  13 | Admin debug information disclosure          | Not covered     | No debug secret exposure alert.                                          |
|  14 | Hardcoded admin credentials                 | Not covered     | No hardcoded admin credential alert.                                     |
|  15 | Plaintext password logging on failed login  | Covered         | `alerts 4, 5`, `go/clear-text-logging`, `backend/handlers/auth.go:68/75` |
|  16 | Missing rate limiting on login              | Not covered     | No rate-limiting alert.                                                  |
|  17 | Open redirect in login                      | Not covered     | No redirect validation alert.                                            |
|  18 | Stored XSS in post content                  | Not covered     | The Go CodeQL run does not cover frontend React XSS sinks here.          |
|  19 | Stored XSS in comment content               | Not covered     | The Go CodeQL run does not cover frontend React XSS sinks here.          |
|  20 | Reflected XSS in search query               | Not covered     | The Go CodeQL run does not cover frontend React XSS sinks here.          |
|  21 | Stored XSS in profile bio                   | Not covered     | The Go CodeQL run does not cover frontend React XSS sinks here.          |
|  22 | Missing CSRF protection                     | Not covered     | No CSRF alert.                                                           |

## Extra Alerts Outside the Answer Key

| Alert | Rule                       | Location                       | Manual review                                    |
| ----: | -------------------------- | ------------------------------ | ------------------------------------------------ |
|     2 | `go/cookie-secure-not-set` | `backend/handlers/auth.go:94`  | Extra session-cookie hardening surface.          |
|     3 | `go/cookie-secure-not-set` | `backend/handlers/auth.go:112` | Same surface as alert 2 at another cookie write. |

## False Positive Review

Manual review found no false positives among the 11 CodeQL alerts. After duplicate alert grouping, the reviewed precision numerator is 8 true-positive security surfaces: 7 answer-key surfaces plus 1 extra session-cookie hardening surface.

The two `go/cookie-secure-not-set` alerts are not counted as answer-key coverage, but they are real session-cookie hardening findings because the session cookie is written with `Secure=false`. They are therefore classified as an extra true-positive security surface outside the answer key, not as false positives.

## Interpretation

CodeQL covers several concrete backend sink classes well: SQL injection, path traversal, command injection, SSRF, and clear-text password logging. It does not cover most repository-level or application-design issues in the Raddit answer key, including authorization/IDOR, JWT design flaws, broad CSRF, rate limiting, upload validation, response-data exposure, and frontend XSS.
