# Semgrep Findings

## Source

This report uses the Semgrep Platform Code findings export:

[Semgrep_Code_Combined_Findings_2026_05_02.csv](Semgrep_Code_Combined_Findings_2026_05_02.csv)

It also references the Semgrep Platform Supply Chain findings export:

[Semgrep_Supply_Chain_Findings_2026_05_02.csv](Semgrep_Supply_Chain_Findings_2026_05_02.csv)

## Summary

Semgrep produced 12 code findings. Manual mapping to the 19-item Book Shop answer-key comparison used by this evaluation shows 3 covered answer-key vulnerabilities and 16 not covered.

```text
Answer-key recall = 3 / 19 = 15.8%
```

The 12 findings correspond to 6 application security surfaces after duplicate and overlapping locations are merged. Semgrep directly covers three answer-key file/path surfaces: asset path traversal, avatar upload filename traversal, and admin log directory/file traversal. It also reports additional admin export path traversal and XML-parser hardening surfaces outside the scored answer-key set.

| Measure                                     | Result               |
| ------------------------------------------- | -------------------- |
| Semgrep code findings                       | 12                   |
| Answer-key items covered                    | 3 / 19 (15.8%)       |
| Answer-key items not covered                | 16 / 19 (84.2%)      |
| Extra code findings outside answer key      | 4                    |
| Code finding severity                       | 1 High, 11 Medium    |
| Code finding confidence                     | 1 High, 11 Low       |
| Reviewed precision after duplicate grouping | 6 / (6 + 0) = 100.0% |

## Mapping to Answer

|   # | Answer-key vulnerability                             | Semgrep coverage | Evidence                                                                                                                                                          |
| --: | ---------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | SQL injection (search/login/register)                | Not covered      | No `$queryRawUnsafe` SQL injection alert in the search/login/register routes.                                                                                     |
|   2 | JWT bypass (alg:none + weak secret)                  | Not covered      | No JWT algorithm validation or weak-secret alert in `src/lib/jwt.ts`.                                                                                             |
|   3 | Asset path traversal                                 | Covered          | `772975427`, `javascript.express.file.fs-express.fs-express`, `src/app/api/assets/route.ts:22`; also overlapping `772975417` at `src/app/api/assets/route.ts:16`. |
|   4 | IDOR (order history + review deletion)               | Not covered      | No authorization or ownership alert.                                                                                                                              |
|   5 | Client-controlled checkout total / price tampering   | Not covered      | No business-logic or server-side price validation alert.                                                                                                          |
|   6 | Plaintext password storage                           | Not covered      | No password hashing or plaintext credential storage alert.                                                                                                        |
|   7 | Stored XSS in reviews                                | Not covered      | No React `innerHTML` / stored XSS alert in this export.                                                                                                           |
|   8 | Reflected XSS in search query                        | Not covered      | No React `dangerouslySetInnerHTML` alert in this export.                                                                                                          |
|   9 | Profile mass assignment / privilege escalation       | Not covered      | No mass-assignment alert.                                                                                                                                         |
|  10 | CSRF via cookie-authenticated profile update         | Not covered      | No CSRF, cookie-auth, or Origin/token validation alert.                                                                                                           |
|  11 | Login open redirect                                  | Not covered      | No unvalidated redirect alert for the login `next` parameter.                                                                                                     |
|  12 | Ineffective login rate limiting                      | Not covered      | No rate-limiting alert.                                                                                                                                           |
|  13 | Race condition in balance updates                    | Not covered      | No concurrency or transaction-safety alert.                                                                                                                       |
|  14 | Sensitive data exposure (reviews API + stack traces) | Not covered      | No data exposure or error-detail exposure alert.                                                                                                                  |
|  15 | Command injection in admin export                    | Not covered      | No command-injection alert.                                                                                                                                       |
|  16 | Unrestricted file upload (avatar)                    | Covered          | `772975416`, path traversal in `src/app/api/users/avatar/route.ts:33`, covers the filename traversal/overwrite component of the avatar upload issue.              |
|  17 | Second-order SQL injection in admin reports          | Not covered      | No raw SQL injection alert in `/api/admin/reports`.                                                                                                               |
|  18 | Directory listing / log file disclosure              | Covered          | `772975422`, `772975421`, `772975420`, `772975419`, and `772975418` cover attacker-influenced admin log directory and file reads.                                 |
|  19 | XXE in XML import                                    | Not covered      | No XML external entity handling alert.                                                                                                                            |

## Duplicate Or Overlapping Findings

|                  Finding | Rule                                                                                                    | Location                               | Manual review                                                                                                                                                                                   |
| -----------------------: | ------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|              `772975417` | `javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal` | `src/app/api/assets/route.ts:16`       | Duplicate location for the answer-key asset traversal surface covered by `772975427`.                                                                                                           |
|              `772975423` | `javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal` | `src/app/api/admin/export/route.ts:34` | Extra admin export path traversal surface outside the scored answer-key set.                                                                                                                    |
|              `772975422` | `javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal` | `src/app/api/admin/logs/route.ts:23`   | Answer-key #18 admin log directory traversal surface.                                                                                                                                           |
| `772975421`, `772975420` | `javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal` | `src/app/api/admin/logs/route.ts:27`   | Duplicate/overlapping findings for answer-key #18 filesystem operations under attacker-influenced `dir`.                                                                                        |
| `772975419`, `772975418` | `javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal` | `src/app/api/admin/logs/route.ts:33`   | Duplicate/overlapping findings for answer-key #18 attacker-selected log file reads.                                                                                                             |
|              `772975416` | `javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal` | `src/app/api/users/avatar/route.ts:33` | Answer-key #16 avatar upload filename traversal surface.                                                                                                                                        |
| `772975426`, `772975425` | `javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp`                    | `src/app/api/books/import/route.ts:19` | XML parser hardening findings on dynamic `RegExp`. Related to the custom XML import parser, but they identify ReDoS-style regex risk rather than the stronger XXE/arbitrary-file-read behavior. |
|              `772975424` | `javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp`                    | `src/app/api/books/import/route.ts:23` | XML parser hardening finding on dynamic tag extraction. Same parser family as the previous row.                                                                                                 |

## False Positive Review

Manual review found no false positives among the 12 Semgrep code findings. After duplicate alert grouping, the reviewed precision numerator is 6 true-positive application security surfaces: 3 answer-key surfaces (asset path traversal, avatar upload filename traversal, and admin log traversal/disclosure) plus 3 extra hardening surfaces in admin export and the custom XML parser.

The XML parser findings are best viewed as hardening leads (dynamic regex usage) rather than precise XXE coverage. They are still real security surfaces, but they do not map to the answer-key XXE item.

## Supply Chain Findings

Semgrep also produced 4 supply-chain findings. These are not counted toward the 19-item Book Shop answer-key recall because the answer-key comparison focuses on manually injected application vulnerabilities. They are reported separately as dependency-risk coverage.

| Measure                          | Result                             |
| -------------------------------- | ---------------------------------- |
| Supply-chain findings            | 4                                  |
| Medium severity                  | 4                                  |
| Reachability analysis            | No reachability analysis for all 4 |
| Direct dependencies              | 0                                  |
| Transitive dependencies          | 4                                  |
| Answer-key coverage contribution | 0 / 19                             |

|     Finding | Dependency          | Version   | Severity | Reachability             | Transitivity | Advisory              |
| ----------: | ------------------- | --------- | -------- | ------------------------ | ------------ | --------------------- |
| `772975433` | `@hono/node-server` | `1.19.11` | Medium   | No Reachability Analysis | Transitive   | `CVE-2026-39406`      |
| `772975432` | `hono`              | `4.12.12` | Medium   | No Reachability Analysis | Transitive   | `GHSA-458j-xx4x-4375` |
| `772975431` | `postcss`           | `8.5.9`   | Medium   | No Reachability Analysis | Transitive   | `CVE-2026-41305`      |
| `772975430` | `postcss`           | `8.4.31`  | Medium   | No Reachability Analysis | Transitive   | `CVE-2026-41305`      |

The supply-chain export gives dependency hygiene signals only. None of the four advisories includes reachability evidence in this export, so they should be reviewed separately from application vulnerability recall.

## Interpretation

Semgrep Code is strongest here on filesystem path construction. It directly covers asset path traversal, avatar upload filename traversal, and admin log traversal/disclosure, and it surfaces an additional path traversal risk in admin export. It does not cover most of the benchmark's repository-level or application-design flaws: raw SQL injection, JWT bypass and weak secret, IDOR, price tampering, plaintext password storage, React XSS, mass assignment, CSRF, open redirect, and ineffective rate limiting. Its XML import findings are useful hardening leads, but they do not precisely capture the custom parser's arbitrary local file read behavior.
