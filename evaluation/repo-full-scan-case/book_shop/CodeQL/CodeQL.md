# CodeQL Code Scanning Alerts

## Fetch From GitHub

```bash
set -euo pipefail

# cd book_shop

OWNER=$(gh repo view --json owner -q '.owner.login')
REPO=$(gh repo view --json name -q '.name')

# Set this to the directory where code-scanning-alerts.json should be written.
REPO_ROOT=/path/to/sec-review-bot
OUT="$REPO_ROOT/evaluation/repo-full-scan-case/book_shop/CodeQL"

mkdir -p "$OUT"

gh api --paginate \
  "/repos/$OWNER/$REPO/code-scanning/alerts?state=all&per_page=100" \
  > "$OUT/code-scanning-alerts.json"
```

[code-scanning-alerts.json](code-scanning-alerts.json)

## Summary

GitHub CodeQL produced 4 code scanning alerts. Manual mapping to the 19-item Book Shop answer-key comparison used by this evaluation shows 1 covered answer-key vulnerability and 18 not covered; answer-key recall is 1 / 19 = 5.3%.

The 4 alerts are still useful security signals. One alert covers the answer-key admin export command injection item, one alert points to an extra admin export path traversal surface, one is an overlapping shell-command hardening warning on the same export command, and one is GitHub Actions workflow hardening.

| Measure                                                | Result               |
| ------------------------------------------------------ | -------------------- |
| Code scanning alerts                                   | 4                    |
| Answer-key recall                                      | 1 / 19 (5.3%)        |
| Answer-key items not covered                           | 18 / 19 (94.7%)      |
| Extra application security surfaces outside answer key | 1                    |
| Workflow hardening alerts                              | 1                    |
| Reviewed precision after duplicate grouping            | 2 / (2 + 0) = 100.0% |

## Mapping to Answer

|   # | Answer-key vulnerability                             | CodeQL coverage | Evidence                                                                            |
| --: | ---------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------- |
|   1 | SQL injection (search/login/register)                | Not covered     | No `$queryRawUnsafe` SQL injection alert in the search/login/register routes.       |
|   2 | JWT bypass (alg:none + weak secret)                  | Not covered     | No JWT algorithm validation or weak-secret alert in `src/lib/jwt.ts`.               |
|   3 | Asset path traversal                                 | Not covered     | CodeQL did not alert on `/api/assets?file=` path construction.                      |
|   4 | IDOR (order history + review deletion)               | Not covered     | No authorization or ownership alert.                                                |
|   5 | Client-controlled checkout total / price tampering   | Not covered     | No business-logic or server-side price validation alert.                            |
|   6 | Plaintext password storage                           | Not covered     | No password hashing or plaintext credential storage alert.                          |
|   7 | Stored XSS in reviews                                | Not covered     | No React `innerHTML` / stored XSS alert.                                            |
|   8 | Reflected XSS in search query                        | Not covered     | No React `dangerouslySetInnerHTML` alert.                                           |
|   9 | Profile mass assignment / privilege escalation       | Not covered     | No mass-assignment alert.                                                           |
|  10 | CSRF via cookie-authenticated profile update         | Not covered     | No CSRF, cookie-auth, or Origin/token validation alert.                             |
|  11 | Login open redirect                                  | Not covered     | No unvalidated redirect alert for the login `next` parameter.                       |
|  12 | Ineffective login rate limiting                      | Not covered     | No rate-limiting alert.                                                             |
|  13 | Race condition in balance updates                    | Not covered     | No concurrent update or transaction-safety alert.                                   |
|  14 | Sensitive data exposure (reviews API + stack traces) | Not covered     | No data exposure alert on `include: { user: true }` or error-detail exposure alert. |
|  15 | Command injection in admin export                    | Covered         | `alert 3`, `js/command-line-injection`, `src/app/api/admin/export/route.ts:38`      |
|  16 | Unrestricted file upload (avatar)                    | Not covered     | No upload validation alert.                                                         |
|  17 | Second-order SQL injection in admin reports          | Not covered     | No raw SQL injection alert in `/api/admin/reports`.                                 |
|  18 | Directory listing / log file disclosure              | Not covered     | No directory listing or file read exposure alert.                                   |
|  19 | XXE in XML import                                    | Not covered     | No XML external entity handling alert.                                              |

## Extra Alerts Outside the Answer Key

| Alert | Rule                                          | Location                                  | Manual review                                                                                                     |
| ----: | --------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
|     4 | `js/path-injection`                           | `src/app/api/admin/export/route.ts:35`    | Extra admin export path traversal surface: user-controlled `filename` reaches `path.join` and `fs.writeFileSync`. |
|     2 | `js/shell-command-injection-from-environment` | `src/app/api/admin/export/route.ts:38`    | Overlapping hardening warning on the same `execAsync` command, not a separate answer-key surface.                 |
|     1 | `actions/missing-workflow-permissions`        | `.github/workflows/sec-review-bot.yml:31` | Repository workflow hardening signal, not an application vulnerability and not part of answer-key recall.         |

## False Positive Review

Manual review found no false positives among the 4 CodeQL alerts. After duplicate alert grouping, the reviewed precision numerator is 2 true-positive application security surfaces: 1 answer-key surface (admin export command injection) plus 1 extra admin export path traversal surface.

The `js/shell-command-injection-from-environment` alert overlaps the same `execAsync` command already flagged by the stronger user-controlled `js/command-line-injection` rule. The `actions/missing-workflow-permissions` alert is a real repository hardening signal, but it is not an application vulnerability and is not counted toward answer-key recall.

## Interpretation

CodeQL was narrow on this TypeScript/Next.js benchmark. It found the admin export command-injection sink (covered answer-key item) plus an extra admin export path traversal surface, but missed the rest of the scored answer-key surfaces: SQL injection, JWT design flaws, asset path traversal, IDOR, price tampering, plaintext password storage, React XSS, mass assignment, CSRF, open redirect, ineffective rate limiting, race conditions, sensitive data exposure, unrestricted upload, second-order SQL injection, directory listing/log leakage, and XXE.
