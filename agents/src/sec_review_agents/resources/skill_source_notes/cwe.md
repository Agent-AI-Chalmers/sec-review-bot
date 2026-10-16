# CWE Skill Source Notes

## Authoritative scope and mapping rules

CWE is a classification aid after repository-grounded analysis, not evidence that a vulnerability exists or a source of required skill domains.

| Rule group and location | Primary source and locator | Adoption and limits |
| --- | --- | --- |
| CWE-1: navigation categories; `SKILL.md` and `references/cwe-699-agent-navigation.md` | [MITRE View-699](https://cwe.mitre.org/data/definitions/699.html), Description and Relationships | Software Development is a navigation view. Local category examples are incomplete; neither local membership nor view depth limits eligible labels. |
| CWE-2: abstraction and mapping usage; same files, mapping instructions | [MITRE Root Cause Mapping Guidance](https://cwe.mitre.org/documents/cwe_usage/guidance.html), abstraction-level guidance and the ALLOWED/DISCOURAGED/PROHIBITED mapping-label explanation | Prefer an accurate Base/Variant; an appropriate Class is acceptable when no accurate more-specific weakness fits. Check the entry's mapping usage. Categories are not vulnerability labels. Do not force a second-level label. |
| CWE-3: optional labels and prose-first explanation; `SKILL.md`, Output Rules | Project output policy, informed by MITRE's accurate-root-cause guidance | The project permits no CWE when a suitable mapping cannot be verified. MITRE does not prescribe this project's output schema or optional-label policy. |

## Navigation index scope

The local reference is a partial, agent-oriented navigation aid based on [MITRE CWE View-699 (Software Development)](https://cwe.mitre.org/data/definitions/699.html). CWE definitions and relationships come from MITRE; the local organization and choice of examples are project editorial choices, not an official coverage boundary or mapping restriction.

Maintain the reference under these constraints:

- Treat categories and examples as search aids, not a closed set of permitted labels.
- Verify the official weakness definition, abstraction and mapping usage before assigning a label; a local alias or category placement is insufficient.
- Do not infer that an unexpanded category is unsupported by the agent or outside the review scope.
- Do not use the inventory to choose security domains, prioritize skills, or claim complete coverage.
- Add or correct an example only when authoritative material supports its definition and navigation role. Do not expand the index from benchmark labels or outcomes.

The skill does not require a comprehensive local CWE catalog. If the selected examples bias mapping or become costly to maintain, prefer a smaller accurate navigation aid over a larger unchecked inventory.
