# Semgrep Findings

## Source

This report uses the Semgrep Platform Code findings export:

[Semgrep_Code_Findings_2026_05_05.csv](Semgrep_Code_Findings_2026_05_05.csv)

It also references the Semgrep Platform Supply Chain findings export:

[Semgrep_Supply_Chain_Findings_2026_05_05.csv](Semgrep_Supply_Chain_Findings_2026_05_05.csv)

## Summary

Semgrep produced 25 code findings. Manual mapping to the 21-item WorldPress answer-key comparison used by this evaluation shows 8 covered answer-key vulnerabilities and 13 not covered.

```text
Answer-key recall = 8 / 21 = 38.1%
```

The 25 findings correspond to 12 application security surfaces after duplicate and overlapping locations are merged. Semgrep directly covers SQL injection (login, search), stored/reflected XSS, command injection, SSRF, unsafe deserialization, and XXE. It misses most access-control and business-logic issues in the answer key.

| Measure                                       | Result                               |
| --------------------------------------------- | ------------------------------------ |
| Semgrep code findings                         | 25                                   |
| Answer-key items covered                      | 8 / 21 (38.1%)                       |
| Answer-key items not covered                  | 13 / 21 (61.9%)                      |
| Extra code findings outside answer key        | 4                                    |
| Code finding severity                         | 3 Critical, 12 High, 9 Medium, 1 Low |
| Code finding confidence                       | 10 High, 9 Medium, 6 Low             |
| Reviewed precision after duplicate grouping   | 12 / (12 + 0) = 100.0%               |
| False discovery rate after duplicate grouping | 0 / (12 + 0) = 0.0%                  |

## Mapping to Answer

|   # | Answer-key vulnerability                | Semgrep coverage | Evidence                                                                                                                                                                 |
| --: | --------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|   1 | SQL injection (login)                   | Covered          | `772975681`, `python.flask.db.generic-sql-flask.generic-sql-flask`, `worldpress/backend/routes/auth.py#L54`.                                                             |
|   2 | Open redirect                           | Not covered      | No unvalidated redirect alert in `worldpress/backend/routes/auth.py`.                                                                                                    |
|   3 | Missing rate limiting (login)           | Not covered      | No rate-limiting alert.                                                                                                                                                  |
|   4 | Weak JWT secret                         | Not covered      | No hardcoded/weak secret alert.                                                                                                                                          |
|   5 | IDOR (read user)                        | Not covered      | No authorization/ownership alert in `worldpress/backend/routes/users.py`.                                                                                                |
|   6 | Mass assignment (privilege escalation)  | Not covered      | No mass-assignment alert in `worldpress/backend/routes/users.py`.                                                                                                        |
|   7 | Sensitive data exposure (password hash) | Not covered      | No sensitive-data-in-response alert for user endpoints.                                                                                                                  |
|   8 | SQL injection (search)                  | Covered          | `772975680`, `python.flask.db.generic-sql-flask.generic-sql-flask`, `worldpress/backend/routes/posts.py#L38`.                                                            |
|   9 | Stored XSS (post content)               | Covered          | `772975666`, `javascript.vue.security.audit.xss.templates.avoid-v-html.avoid-v-html`, `worldpress/frontend/src/views/PostEdit.vue#L71`.                                  |
|  10 | IDOR (edit/delete post)                 | Not covered      | No authorization/ownership alert in `worldpress/backend/routes/posts.py`.                                                                                                |
|  11 | Path traversal (download)               | Not covered      | No path traversal alert in `worldpress/backend/routes/media.py`.                                                                                                         |
| 11b | Path traversal (preview, no auth)       | Not covered      | No path traversal alert in `worldpress/backend/routes/media.py`.                                                                                                         |
|  12 | Unrestricted file upload                | Not covered      | No file upload validation alert in `worldpress/backend/routes/media.py`.                                                                                                 |
|  13 | Command injection                       | Covered          | `772975675`, `python.flask.os.tainted-os-command-stdlib-flask-secure-default.tainted-os-command-stdlib-flask-secure-default`, `worldpress/backend/routes/media.py#L118`. |
|  14 | SSRF                                    | Covered          | `772975676`, `python.flask.net.tainted-flask-http-request-requests.tainted-flask-http-request-requests`, `worldpress/backend/routes/settings.py#L72`.                    |
|  15 | Hardcoded credential exposure           | Not covered      | No hardcoded-credential exposure alert in `worldpress/backend/routes/settings.py`.                                                                                       |
|  16 | Insecure deserialization (pickle)       | Covered          | `772975677`, `python.flask.deserialization.tainted-pickle-flask.tainted-pickle-flask`, `worldpress/backend/routes/settings.py#L96`.                                      |
|  17 | XXE                                     | Covered          | `772975672`, `python.flask.xml.tainted-flask-xml-lxml.tainted-flask-xml-lxml`, `worldpress/backend/routes/settings.py#L128`.                                             |
|  18 | Stack trace exposure                    | Not covered      | No stack-trace exposure alert in `worldpress/backend/app.py`.                                                                                                            |
|  19 | Access control bypass (header)          | Not covered      | No auth-bypass alert in `worldpress/backend/routes/users.py` or `worldpress/backend/routes/settings.py`.                                                                 |
|  20 | Stored XSS (comments)                   | Not covered      | No stored XSS alert for comment content handling.                                                                                                                        |
|  21 | Reflected XSS (comment author)          | Covered          | `772975665`, `python.django.security.injection.raw-html-format.raw-html-format`, `worldpress/backend/routes/posts.py#L181`.                                              |

## Duplicate Or Overlapping Findings

|                                            Finding | Rule                                                                                                                                                                                                | Location                                                                             | Manual review                                                                               |
| -------------------------------------------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
|                           `772975679`, `772975667` | `python.flask.db.generic-sql-flask.generic-sql-flask`, `python.sqlalchemy.security.sqlalchemy-execute-raw-query.sqlalchemy-execute-raw-query`                                                       | `worldpress/backend/routes/users.py#L86`                                             | SQL injection in dynamic `UPDATE` statement; not part of the answer key.                    |
|                                        `772975671` | `python.jwt.security.jwt-none-alg.jwt-python-none-alg`                                                                                                                                              | `worldpress/backend/routes/auth.py#L25`                                              | JWT `none` algorithm acceptance; outside the answer key.                                    |
|              `772975664`, `772975663`, `772975657` | `python.flask.security.audit.app-run-param-config.avoid_app_run_with_bad_host`, `python.flask.security.audit.debug-enabled.debug-enabled`, `python.flask.debug.debug-flask.active-debug-code-flask` | `worldpress/backend/app.py#L41`                                                      | Debug mode and public host configuration; security hardening issues outside the answer key. |
|                           `772975660`, `772975659` | `python.lang.security.audit.md5-used-as-password.md5-used-as-password`                                                                                                                              | `worldpress/backend/routes/auth.py#L47` and `worldpress/backend/routes/auth.py#L130` | Weak password hashing (MD5) outside the answer key.                                         |
| `772975678`, `772975673`, `772975661`, `772975668` | SQL injection overlap rules                                                                                                                                                                         | `worldpress/backend/routes/auth.py#L54`                                              | Duplicate SQL injection findings on the login query surface.                                |
|              `772975674`, `772975670`, `772975669` | Subprocess injection overlap rules                                                                                                                                                                  | `worldpress/backend/routes/media.py#L118`                                            | Duplicate command-injection findings on the thumbnail command.                              |
|                                        `772975662` | `python.flask.security.injection.raw-html-concat.raw-html-format`                                                                                                                                   | `worldpress/backend/routes/posts.py#L181`                                            | Overlapping reflected XSS finding on the same HTML response.                                |

## False Positive Review

No false positives identified in the Semgrep code findings based on manual review.

## Supply Chain Findings

Semgrep produced 13 supply-chain findings. These are not counted toward the 21-item answer-key recall because the answer-key comparison focuses on manually injected application vulnerabilities. They are reported separately as dependency-risk coverage.

| Measure               | Result                                   |
| --------------------- | ---------------------------------------- |
| Supply-chain findings | 13                                       |
| High severity         | 2                                        |
| Medium severity       | 10                                       |
| Low severity          | 1                                        |
| Reachability analysis | 2 Reachable, 11 No Reachability Analysis |

|     Finding | Dependency   | Version  | Severity | Reachability             | Transitivity | Advisory         |
| ----------: | ------------ | -------- | -------- | ------------------------ | ------------ | ---------------- |
| `772975653` | `flask-cors` | `4.0.1`  | High     | Reachable                | Unknown      | `CVE-2024-6221`  |
| `772975652` | `pyjwt`      | `2.8.0`  | High     | Reachable                | Unknown      | `CVE-2026-32597` |
| `772975650` | `werkzeug`   | `3.0.3`  | Medium   | No Reachability Analysis | Unknown      | `CVE-2024-49766` |
| `772975649` | `werkzeug`   | `3.0.3`  | Medium   | No Reachability Analysis | Unknown      | `CVE-2024-49767` |
| `772975648` | `flask-cors` | `4.0.1`  | Medium   | No Reachability Analysis | Unknown      | `CVE-2024-6866`  |
| `772975647` | `flask-cors` | `4.0.1`  | Medium   | No Reachability Analysis | Unknown      | `CVE-2024-6839`  |
| `772975646` | `flask-cors` | `4.0.1`  | Medium   | No Reachability Analysis | Unknown      | `CVE-2024-6844`  |
| `772975645` | `requests`   | `2.32.3` | Medium   | No Reachability Analysis | Unknown      | `CVE-2024-47081` |
| `772975644` | `werkzeug`   | `3.0.3`  | Medium   | No Reachability Analysis | Unknown      | `CVE-2025-66221` |
| `772975643` | `werkzeug`   | `3.0.3`  | Medium   | No Reachability Analysis | Unknown      | `CVE-2026-21860` |
| `772975642` | `werkzeug`   | `3.0.3`  | Medium   | No Reachability Analysis | Unknown      | `CVE-2026-27199` |
| `772975641` | `requests`   | `2.32.3` | Medium   | No Reachability Analysis | Unknown      | `CVE-2026-25645` |
| `772975640` | `flask`      | `3.0.3`  | Low      | No Reachability Analysis | Unknown      | `CVE-2026-27205` |

## Interpretation

Semgrep is strongest here on SQL injection, injection sinks (command injection), SSRF, unsafe deserialization, and XXE. It covers the reflected XSS response and the Vue `v-html` stored XSS surface, but misses the path traversal endpoints, access-control bypass, IDOR, mass assignment, rate limiting, and hardcoded credentials in the answer key. It also reports several overlapping findings per sink, so results benefit from deduplication when assessing coverage.
