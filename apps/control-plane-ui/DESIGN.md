# Control Plane UI Design

Language: English | [中文](DESIGN.zh.md)

This console helps operators determine what the system is doing, inspect the evidence, and decide whether intervention is needed. Show state accurately, make evidence readable, and make the consequences of actions clear.

## Operational clarity

Keep run identity, lifecycle state, failure evidence, and available actions close together. Separate preparation, execution, and publication: success in one stage does not imply success in another. Distinguish automatic recovery, a final outcome, and a decision requiring an operator.

Use text as well as color to communicate state. An unsuccessful attempt is not necessarily a final failure; describe whether the system can retry or must first establish the remote outcome. Explain uncertain results without claiming that an external write did or did not happen.

## Language and state presentation

English and Chinese are equal UI languages. Maintain their labels and explanations together in [i18n.tsx](browser/shared/i18n.tsx). Keep code identifiers, run IDs, and failure codes intact; explain them in the surrounding language rather than translating their values.

<!-- doc-default: control-plane-ui.state-presentation; source=apps/control-plane-ui/browser/features/runs/status.tsx -->

Run summaries, filters, diagrams, and event history share state labels. [status.tsx](browser/features/runs/status.tsx) owns the visual tones. State, transition, and machine text is not UI text: it comes in both languages from the generated state-machine module, built from the contract and its [Chinese overlay](../../contracts/review-runs-api/v1/overlays/zh.yaml), so change it there. [Presentation tests](test/logic/state-presentation.test.ts) check that every surface shows the same label in each language.

## Visual foundations

Reuse the definitions below. Update the shared definition for changes that apply across the console. Keep exceptions inside the feature that needs them, with an explanation when the reason is not apparent.

<!-- doc-default: control-plane-ui.visual-foundations; source=apps/control-plane-ui/browser/app/theme.ts -->

| Concern                                      | Maintained source                               |
| -------------------------------------------- | ----------------------------------------------- |
| Component defaults and Latin/CJK font stacks | [theme.ts](browser/app/theme.ts)                |
| Brand palette                                | [colors.ts](browser/app/colors.ts)              |
| Semantic colors for light and dark themes    | [base.css](browser/styles/base.css)             |
| Breakpoints and icon sizes                   | [design.ts](browser/shared/design.ts)           |
| Responsive layout rules                      | [responsive.css](browser/styles/responsive.css) |

Use semantic colors consistently across components. Preserve readable text, focus indicators, and selection in both themes. Use the established Tabler icons and shared size scale; give icon-only controls accessible names. Reserve monospace for content where exact characters matter, such as code and identifiers.

## Interaction and responsive layout

A query change must not leave old results looking like matches for the new query. A refresh of the same query can retain readable results, but should make stale data and refresh failures explicit. Keep retry controls beside the failed content and preserve useful input when recovery is possible.

On narrow screens, arrange each record so its identity, state, and actions stay together. Collapsible filters must retain an applied-filter summary. Long identifiers and translated labels must not hide essential controls. Support keyboard navigation and visible focus alongside touch and pointer input.

Keep investigation context when navigating between related records. Before an action changes active memory or another operational state, identify its target and consequence. Present errors inside the relevant operation so the operator can recover without losing their place.
