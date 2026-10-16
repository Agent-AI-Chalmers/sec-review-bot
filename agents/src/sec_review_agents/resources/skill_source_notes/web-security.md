# Web Security Skill Source Notes

These sources support the `web-security` bundled skill references. Primary sources should be preferred when changing agent-facing content. Third-party skill examples may be retained as inspiration, but they are not authoritative security sources.

## access-control

Primary sources:

- https://portswigger.net/web-security/access-control
- https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html
- https://cwe.mitre.org/data/definitions/639.html
- https://cwe.mitre.org/data/definitions/862.html

## auth-session

Primary sources:

- https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html
- https://portswigger.net/web-security/oauth
- https://portswigger.net/web-security/jwt
- https://cwe.mitre.org/data/definitions/287.html
- https://cwe.mitre.org/data/definitions/384.html

## csrf

Primary sources:

- https://portswigger.net/web-security/csrf
- https://portswigger.net/kb/issues/00200700_cross-site-request-forgery
- https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- https://cwe.mitre.org/data/definitions/352.html

## file-upload

Primary sources:

- https://portswigger.net/web-security/file-upload
- https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
- https://cwe.mitre.org/data/definitions/434.html

Claim ledger:

- Claim: File upload findings require attacker-controlled file content, metadata, name, path, or archive entry reaching a storage, serving, extraction, parser, or execution sink.
  Primary source: OWASP File Upload Cheat Sheet; PortSwigger file upload vulnerabilities.
  Adoption note: A generic upload endpoint is only a lead.
- Claim: Parser/converter handling is security relevant when repository evidence shows known vulnerable parser behavior, unsafe parser features, resource exhaustion, XXE, macro/script execution, or privileged parser exposure.
  Primary source: OWASP File Upload Cheat Sheet.
  Adoption note: Do not report "parser exploit exposure" merely because an uploaded file reaches a parser.
- Claim: Public serving can be safe when content is inert, isolated, and served with safe type/disposition.
  Primary source: OWASP File Upload Cheat Sheet.
  Adoption note: This supports the false-positive precedent against blanket upload findings.

## sensitive-data-exposure

Primary sources:

- https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- https://owasp.org/Top10/A02_2021-Cryptographic_Failures/
- https://cwe.mitre.org/data/definitions/798.html
- https://cwe.mitre.org/data/definitions/209.html

Claim ledger:

- Claim: Web sensitive-data exposure requires a real or plausibly live secret, security token, private data, or sensitive configuration reaching an unauthorized web or browser-visible sink.
  Primary source: OWASP Secrets Management Cheat Sheet; CWE-798.
  Adoption note: Variable names or placeholder values are not enough.
- Claim: Error or tenant-visible log exposure becomes security relevant when sensitive values, credentials, headers, connection strings, stack/context details, or private data reach unauthorized web users or tenants.
  Primary source: OWASP Error Handling Cheat Sheet; OWASP Logging Cheat Sheet; CWE-209.
  Adoption note: Generic error logging is not a finding.
- Claim: Public source maps or bundled source are not secrets exposure unless they contain live secrets, security tokens, or sensitive configuration.
  Primary source: OWASP Secrets Management Cheat Sheet; project classification policy.
  Adoption note: Boundary-bypass details should be proven as separate information disclosure or exploit-chain issues, not folded into secrets exposure.

## sql-injection

Primary sources:

- https://portswigger.net/web-security/sql-injection
- https://portswigger.net/kb/issues/00100200_sql-injection
- https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Query_Parameterization_Cheat_Sheet.html
- https://cwe.mitre.org/data/definitions/89.html

## ssrf

Primary sources:

- https://portswigger.net/web-security/ssrf
- https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
- https://owasp.org/Top10/A10_2021-Server-Side_Request_Forgery_%28SSRF%29/
- https://cwe.mitre.org/data/definitions/918.html

## xss

Primary sources:

- https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/DOM_based_XSS_Prevention_Cheat_Sheet.html
- https://portswigger.net/web-security/cross-site-scripting
- https://portswigger.net/web-security/cross-site-scripting/dom-based
- https://portswigger.net/web-security/cross-site-scripting/contexts
- https://cwe.mitre.org/data/definitions/79.html

Claim ledger:

- Claim: XSS requires attacker-controlled data reaching an executable browser context with missing or insufficient context-appropriate neutralization.
  Primary source: OWASP XSS Prevention Cheat Sheet; PortSwigger XSS contexts.
  Adoption note: The agent-facing reference requires source reachability, context, guard coverage, and impact.
- Claim: Framework default text interpolation is generally not XSS by itself, while escape hatches such as raw HTML sinks need inspection.
  Primary source: OWASP XSS Prevention Cheat Sheet; DOM XSS Prevention Cheat Sheet.
  Adoption note: This supports the React/Angular/Vue interpolation false-positive precedent.
- Claim: URL, attribute, JavaScript, HTML, and template contexts have distinct neutralization requirements.
  Primary source: OWASP XSS Prevention Cheat Sheet; PortSwigger XSS contexts.
  Adoption note: Do not reduce XSS review to `innerHTML` only.
- Claim: CSS/style contexts should be treated as security relevant only with a concrete browser-supported script execution, sensitive data exfiltration, policy bypass, or other security effect.
  Primary source: OWASP XSS Prevention Cheat Sheet, with project false-positive policy.
  Adoption note: Do not report CSS URL injection as XSS without a concrete executable/effect path.

Inspiration sources:

- https://skillsmp.com/de/skills/liminal-ai-code-steward-claude-plugins-code-steward-reviews-skills-security-review-skill-md
- https://skilld.dev/skills/grahamcrackers/skills/security-patterns
- https://playbooks.com/skills/sickn33/antigravity-awesome-skills/frontend-mobile-security-xss-scan

## Audited rule groups: authentication

Reviewed 2026-10-16. These entries trace the changed operational rules by section, rather than attaching a citation to every sentence. Official guidance establishes the mechanism; the repository-evidence threshold is project policy. These sources do not demonstrate that adding the text improves model behavior.

| Rule group and affected reference | Primary support and locator | Adoption and limits |
| --- | --- | --- |
| AUTH-1: identity and token verification; `auth-session.md`, Guards and Report Conditions | [RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html), §§3.1–3.4 and 3.8–3.12 | Algorithm/signature verification and issuer, subject, audience, token-purpose checks have distinct roles. Do not treat a verified signature as sufficient identity binding or require every listed claim in every protocol. |
| AUTH-2: session lifecycle; `auth-session.md`, Guards and Report Conditions | [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), “Renew the Session ID After Any Privilege Level Change” and “Session Expiration”; [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html), §5.2, “Reauthentication” | Inspect renewal, expiry and invalidation against the actual application boundary. NIST describes independent IdP/RP sessions; do not assume universal logout propagation. Failure need not create a new session. |
| AUTH-3: password storage; `auth-session.md`, Guards and Report Conditions | [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html), §3.1.1.2, “Password Verifiers” | Password hashing protects against offline attacks; identify the implementation and state attacker access assumptions. The project does not require this storage defect to also prove database compromise. No algorithm/work-factor table or federal assurance requirement is imported. |
| AUTH-4: guessing and attacker-induced lockout; `auth-session.md`, Guards and Report Conditions | [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html), “Login Throttling” and “Account Lockout”; [CWE-645](https://cwe.mitre.org/data/definitions/645.html), Description | Authentication security includes availability and attempt handling. Show attacker effort, affected account and recovery; missing rate limiting alone remains insufficient. This replaces the incorrect universal requirement for attacker input to become an authenticated identity. |
| AUTH-5: recovery, cookie and existing negative precedents; `auth-session.md`, Sources, Guards and False-Positive Precedents | [OWASP Forgot Password](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html), “URL Tokens” and “User Resets Password”; [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), “Cookies” | Tokens need appropriate binding and lifecycle; cookie protections depend on browser/transport use. Whether a missing protection is reportable remains a repository-specific judgment. Missing MFA is not universally a vulnerability. |

## Additional inherited rule groups

Reviewed 2026-10-16. These entries extend traceability to the main guard and report-condition groups in references that previously had only link inventories. This is a mechanism-level audit, not confirmation of every named API's current behavior.

| Rule group and reference | Primary support and locator | Adoption and limits |
| --- | --- | --- |
| ACCESS-1: trusted-side checks and resolved resource scope; `access-control.md`, Guards and Report Conditions | [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html), “Validate the Permissions on Every Request”, “Verify that Authorization Checks are Performed in the Right Location”, “Exit Safely when Authorization Checks Fail” | UI visibility is not the enforcing boundary. Inspect the actual actor/resource/action and effect. Public resources may intentionally need no authentication or per-user ownership check. A recommendation to centralize checks is not a finding. |
| CSRF-1: ambient credentials and cross-site submission; `csrf.md`, Sources and Report Conditions | [OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html), Introduction, “Disallowing simple requests”, “Custom Headers and CORS” | Establish what the victim browser submits, what credentials accompany it and what action follows. Missing a token alone is insufficient. Do not assume permissive CORS supplies an otherwise unavailable bearer token. |
| CSRF-2: origin/token and cookie controls; `csrf.md`, Guards and False-Positive Precedents | Same source, “Synchronizer Token Pattern”, “SameSite (Cookie Attribute)”, “Using Standard Headers to Verify Origin” | Account for actual cookie mode, origin policy and endpoint behavior. Defense-in-depth guidance does not prove that every single-control deployment is exploitable. Protocol-specific login/account-linking bindings need the relevant authentication specification. |
| SQL-1: data values versus query structure; `sql-injection.md`, Guards and Report Conditions | [OWASP SQL Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html), “Prepared Statements”, “Allow-list Input Validation”, “Safest Use Of Dynamic SQL Generation (DISCOURAGED)” | Parameterized values do not make attacker-selected identifiers or raw structure safe. Verify the exact ORM API and whether it binds values or emits SQL. Finite trusted mappings are a counterexample to blanket dynamic-query findings. |
| SSRF-1: destination policy, redirects and resolution; `ssrf.md`, Guards and Report Conditions | [OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html), “Application layer”, IP/domain validation and DNS pinning guidance | Compare validation with the target actually connected to, including redirects and resolution. A configured host is not necessarily fixed after DNS resolution or redirection. The project additionally requires attacker influence and security effect; accepting a URL is not proof of SSRF. |

Remaining source work: source inventories and grouped ledgers do not verify every inherited language/API example, exact platform default, alias, or negative precedent. In particular, complex OAuth/OIDC flows need their own protocol sources when changed. Trace material changes to report/reject conditions, guard sufficiency and version-sensitive behavior; do not treat a group-level source as support for unrelated details in the same reference.
