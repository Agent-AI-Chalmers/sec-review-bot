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

## command-injection

Primary sources:

- https://portswigger.net/kb/issues/00100100_os-command-injection
- https://portswigger.net/web-security/os-command-injection
- https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html
- https://cwe.mitre.org/data/definitions/78.html
- https://cwe.mitre.org/data/definitions/77.html

## csrf

Primary sources:

- https://portswigger.net/web-security/csrf
- https://portswigger.net/kb/issues/00200700_cross-site-request-forgery
- https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- https://cwe.mitre.org/data/definitions/352.html

## deserialization

Primary sources:

- https://cheatsheetseries.owasp.org/cheatsheets/Deserialization_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/XML_External_Entity_Prevention_Cheat_Sheet.html
- https://cwe.mitre.org/data/definitions/502.html
- https://cwe.mitre.org/data/definitions/611.html

Inspiration sources:

- https://skillsmp.com/skills/dykyi-roman-awesome-claude-code-skills-check-deserialization-skill-md
- https://skillsmp.com/skills/yhy0-ghsa-skill-builder-vuln-skills-skills-pentest-deserialization-xxe-skill-md

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

## path-traversal

Primary sources:

- https://portswigger.net/web-security/file-path-traversal
- https://owasp.org/www-community/attacks/Path_Traversal
- https://cwe.mitre.org/data/definitions/22.html
- https://cwe.mitre.org/data/definitions/73.html

Supplemental sources:

- https://security.snyk.io/research/zip-slip-vulnerability

## secrets-exposure

Primary sources:

- https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- https://owasp.org/Top10/A02_2021-Cryptographic_Failures/
- https://cwe.mitre.org/data/definitions/798.html
- https://cwe.mitre.org/data/definitions/209.html

Claim ledger:

- Claim: Secrets exposure requires a real or plausibly live secret/security token reaching an unauthorized sink such as a response, client bundle, public artifact, or logs visible outside the trust boundary.
  Primary source: OWASP Secrets Management Cheat Sheet; CWE-798.
  Adoption note: Variable names or placeholder values are not enough.
- Claim: Error/log exposure becomes security relevant when sensitive values, credentials, headers, connection strings, stack/context details, or other exploitable sensitive data reach unauthorized users or log readers.
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
