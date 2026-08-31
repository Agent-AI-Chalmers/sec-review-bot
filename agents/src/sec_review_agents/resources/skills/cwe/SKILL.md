---
name: cwe
description: "Assign a concrete, evidence-supported CWE only after a repository-grounded security finding already exists. Use this skill to narrow classification, avoid bad labels, and explain why the chosen CWE fits."
---

# CWE Classification Skill

Use CWE as a naming and reasoning aid after a security finding is already supported by repository evidence.

Do not use CWE lookup as a substitute for finding generation.

## Trigger Conditions

Enter this workflow only when all of the following are true:

- you already have a concrete security finding or a narrowly scoped plausible risk
- the finding is anchored to repository evidence or directly affected behavior
- you want to assign a CWE label or narrow the classification space

Do not enter this workflow when:

- you are still unsure whether there is any actionable finding
- you only have a vague code smell or implementation-quality note
- you are trying to use CWE to prove that a vulnerability exists

## Workflow

1. Restate the finding in plain language. Capture the dangerous behavior, affected
   boundary, and why it matters.

2. Decide whether the problem is primarily about:
   - authentication
   - authorization
   - input or output neutralization
   - file handling
   - numeric or memory safety
   - privilege or resource management
   - business logic
   - another nearby category

3. Read `/skills/cwe/references/cwe-699-agent-navigation.md` to narrow the search area.
   Use category labels for navigation only.

4. Prefer a second-level Base or Variant CWE when there is a natural fit. If multiple
   candidates exist, choose the one closest to the root cause, not the most famous
   label.

5. If only a broad category fits, keep the prose explanation primary and omit a forced
   CWE label.

## Output Rules

- A CWE label is optional, not mandatory.
- Only assign a CWE when the fit is natural and evidence-supported.
- If assigned, include:
  - `cwe_id`
  - `cwe_name`
  - a short rationale explaining why the label fits this finding

## Guardrails

- Never map a finding directly to a CWE Category.
- Do not use CWE to upgrade a weak finding into a stronger one.
- Do not force a precise CWE when the repository evidence is still ambiguous.
- For business-logic and chain-like issues, the prose explanation may be more precise than the CWE label.
