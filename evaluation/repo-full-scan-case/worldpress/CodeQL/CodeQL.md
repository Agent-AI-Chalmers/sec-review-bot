# CodeQL Code Scanning Alerts

## Fetch From GitHub

```bash
set -euo pipefail

# cd worldpress

OWNER=$(gh repo view --json owner -q '.owner.login')
REPO=$(gh repo view --json name -q '.name')

# Set this to the directory where code-scanning-alerts.json should be written.
REPO_ROOT=/path/to/sec-review-bot
OUT="$REPO_ROOT/evaluation/repo-full-scan-case/worldpress/CodeQL"

mkdir -p "$OUT"

gh api --paginate \
  "/repos/$OWNER/$REPO/code-scanning/alerts?state=all&per_page=100" \
  > "$OUT/code-scanning-alerts.json"
```

[code-scanning-alerts.json](code-scanning-alerts.json)

## Summary

GitHub CodeQL produced 20 code scanning alerts. Manual mapping to the 21-item WorldPress answer-key comparison used by this evaluation shows 9 covered answer-key vulnerabilities and 12 not covered; answer-key recall is 9 / 21 = 42.9%.

Several alerts overlap on the same underlying issues (for example, multiple stack-trace exposure alerts and multiple path-traversal alerts). The summary below counts alerts as reported, then maps them to the answer-key items.

| Measure                                                | Result                 |
| ------------------------------------------------------ | ---------------------- |
| Code scanning alerts                                   | 20                     |
| Answer-key recall                                      | 9 / 21 (42.9%)         |
| Answer-key items not covered                           | 12 / 21 (57.1%)        |
| Extra application security surfaces outside answer key | 4                      |
| Non-covering related information-disclosure signals    | 4                      |
| Reviewed false positives                               | 0                      |
| Reviewed precision after duplicate grouping            | 13 / (13 + 0) = 100.0% |
| False discovery rate after duplicate grouping          | 0 / (13 + 0) = 0.0%    |

## Mapping to Answer

|   # | Answer-key vulnerability                | CodeQL coverage | Evidence                                                                                                                                                                                                                                                                                                                                                                    |
| --: | --------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | SQL injection (login)                   | Covered         | Alert `18`, `py/sql-injection`, `worldpress/backend/routes/auth.py#L54`.                                                                                                                                                                                                                                                                                                    |
|   2 | Open redirect                           | Not covered     | No unvalidated redirect alert in `worldpress/backend/routes/auth.py`.                                                                                                                                                                                                                                                                                                       |
|   3 | Missing rate limiting (login)           | Not covered     | No rate-limiting alert.                                                                                                                                                                                                                                                                                                                                                     |
|   4 | Weak JWT secret                         | Not covered     | No hardcoded/weak secret or JWT configuration alert.                                                                                                                                                                                                                                                                                                                        |
|   5 | IDOR (read user)                        | Not covered     | No authorization/ownership alert in `worldpress/backend/routes/users.py`.                                                                                                                                                                                                                                                                                                   |
|   6 | Mass assignment (privilege escalation)  | Not covered     | No mass-assignment alert in `worldpress/backend/routes/users.py`.                                                                                                                                                                                                                                                                                                           |
|   7 | Sensitive data exposure (password hash) | Not covered     | No sensitive-data-in-response alert for user endpoints.                                                                                                                                                                                                                                                                                                                     |
|   8 | SQL injection (search)                  | Covered         | Alert `19`, `py/sql-injection`, `worldpress/backend/routes/posts.py#L38`.                                                                                                                                                                                                                                                                                                   |
|   9 | Stored XSS (post content)               | Not covered     | No stored XSS alert for post content handling.                                                                                                                                                                                                                                                                                                                              |
|  10 | IDOR (edit/delete post)                 | Not covered     | No authorization/ownership alert in `worldpress/backend/routes/posts.py`.                                                                                                                                                                                                                                                                                                   |
|  11 | Path traversal (download)               | Covered         | Alerts `10` and `11`, `py/path-injection`, `worldpress/backend/routes/media.py#L84` and `worldpress/backend/routes/media.py#L87`.                                                                                                                                                                                                                                           |
| 11b | Path traversal (preview, no auth)       | Covered         | Alerts `12` and `13`, `py/path-injection`, `worldpress/backend/routes/media.py#L96` and `worldpress/backend/routes/media.py#L99`.                                                                                                                                                                                                                                           |
|  12 | Unrestricted file upload                | Not covered     | No file upload validation alert in `worldpress/backend/routes/media.py`.                                                                                                                                                                                                                                                                                                    |
|  13 | Command injection                       | Covered         | Alert `1`, `py/command-line-injection`, `worldpress/backend/routes/media.py#L118`.                                                                                                                                                                                                                                                                                          |
|  14 | SSRF                                    | Covered         | Alert `9`, `py/full-ssrf`, `worldpress/backend/routes/settings.py#L72`.                                                                                                                                                                                                                                                                                                     |
|  15 | Hardcoded credential exposure           | Not covered     | No hardcoded-credential exposure alert in `worldpress/backend/routes/settings.py`.                                                                                                                                                                                                                                                                                          |
|  16 | Insecure deserialization (pickle)       | Covered         | Alert `7`, `py/unsafe-deserialization`, `worldpress/backend/routes/settings.py#L96`.                                                                                                                                                                                                                                                                                        |
|  17 | XXE                                     | Covered         | Alert `8`, `py/xxe`, `worldpress/backend/routes/settings.py#L128`.                                                                                                                                                                                                                                                                                                          |
|  18 | Stack trace exposure                    | Covered         | Alert `2`, `py/stack-trace-exposure`, `worldpress/backend/app.py#L26-L30`, where the global exception handler returns `traceback.format_exc()` in the JSON response. Alerts `3`-`6` are reviewed below as related information-disclosure signals that do not cover this full-stack-trace answer-key item because those routes return exception messages but not tracebacks. |
|  19 | Access control bypass (header)          | Not covered     | No auth-bypass alert in `worldpress/backend/routes/users.py` or `worldpress/backend/routes/settings.py`.                                                                                                                                                                                                                                                                    |
|  20 | Stored XSS (comments)                   | Not covered     | No stored XSS alert for comment content handling.                                                                                                                                                                                                                                                                                                                           |
|  21 | Reflected XSS (comment author)          | Covered         | Alert `14`, `py/reflective-xss`, `worldpress/backend/routes/posts.py#L181-L183`.                                                                                                                                                                                                                                                                                            |

## Extra Alerts Outside the Answer Key

| Alert | Rule                             | Location                                 | Manual review                                                                             |
| ----: | -------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
|    20 | `py/sql-injection`               | `worldpress/backend/routes/users.py#L86` | SQL injection in dynamic `UPDATE` statement, but not part of the injected answer-key set. |
|    17 | `py/flask-debug`                 | `worldpress/backend/app.py#L41`          | Debug mode enabled in Flask runtime; security hardening issue outside the answer key.     |
|    16 | `py/weak-sensitive-data-hashing` | `worldpress/backend/routes/auth.py#L130` | MD5 used for password hashing; weak hashing issue outside the answer key.                 |
|    15 | `py/weak-sensitive-data-hashing` | `worldpress/backend/routes/auth.py#L47`  | MD5 used for password hashing; weak hashing issue outside the answer key.                 |

## Non-Covering Related Signals

The stack-trace answer-key item remains covered by alert `2`. Alerts `3`-`6` are not counted as answer-key coverage because they return exception strings rather than full tracebacks. They are treated as related error-information-disclosure signals, not as reviewed false positives.

| Alert | Rule                      | Location                                     | Notes                                              |
| ----: | ------------------------- | -------------------------------------------- | -------------------------------------------------- |
|     3 | `py/stack-trace-exposure` | `worldpress/backend/routes/settings.py#L79`  | Returns only exception message, not a stack trace. |
|     4 | `py/stack-trace-exposure` | `worldpress/backend/routes/settings.py#L98`  | Returns only exception message, not a stack trace. |
|     5 | `py/stack-trace-exposure` | `worldpress/backend/routes/settings.py#L130` | Returns only exception message, not a stack trace. |
|     6 | `py/stack-trace-exposure` | `worldpress/backend/routes/users.py#L90`     | Returns only exception message, not a stack trace. |

## Interpretation

CodeQL is strong on this Python/Flask benchmark for classic injection categories (SQL injection, command injection), SSRF, unsafe deserialization, XXE, and stack-trace exposure. It does not cover many authorization or business-logic flaws in the answer key (IDOR, mass assignment, open redirect, rate limiting, and access-control bypass). It also misses the stored XSS surfaces, while correctly flagging the reflected XSS response in comments.
