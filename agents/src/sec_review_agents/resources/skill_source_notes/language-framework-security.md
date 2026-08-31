# language-framework-security Vendor Extraction

Source:

- https://github.com/lawvable/awesome-legal-skills/tree/main/skills/security-review-openai
- https://agent-skills.md/skills/lawvable/awesome-legal-skills/security-review-openai
- https://mcpmarket.com/tools/skills/security-best-practice-reviewer

Decision:

- Use `security-review-openai` as vendor source material for the bundled `language-framework-security` skill.
- Do not install the vendor skill directly.
- Do not copy the vendor root reviewer behavior.

Why:

- The useful part is its language/framework split for Go, Python web frameworks, and JavaScript/TypeScript frameworks.
- The risky part is its root posture: broad best-practices review, scanning, audit/report framing, and secure-by-default checklist behavior.
- Our agent-facing skill must remain a reference pack for repository-grounded evidence, not a new reviewer persona.

Extracted into project-owned references:

- Go backend
- Django
- FastAPI
- Flask
- Express
- browser JavaScript
- jQuery
- Next.js
- React
- Vue

Extraction rules:

- Keep language and framework semantics that help inspect concrete code.
- Keep route/entry-point hints when they help the agent find relevant files.
- Rewrite examples as repository-evidence guidance.
- Drop vendor scan-all instructions, reporting workflow, dependency-audit posture, and generic hardening checklist tone.
- Keep source links in this note only. Agent-facing references should not expose source-note links.

## Claim Ledger

Accepted from vendor source:

- The language/framework split is useful for progressive disclosure.
- Go, Python web frameworks, and JavaScript/TypeScript frameworks are common enough in target repositories to justify bundled references.
- Framework behavior such as template escaping, middleware order, route handling, request parsing, static file serving, and server/client boundaries is useful review context.

Project-owned claims added during extraction:

- These references are inspection aids, not proof of a finding.
- Repository evidence decides whether a vulnerability exists, not the vendor best-practices checklist.
- Runtime commands, dependency audit, broad SAST, and hardening reports are not default behavior for this skill.

Rejected or rewritten vendor posture:

- Do not treat the skill as a general security audit persona.
- Do not ask the agent to scan every framework feature.
- Do not emit findings merely because code differs from a secure-by-default checklist.
