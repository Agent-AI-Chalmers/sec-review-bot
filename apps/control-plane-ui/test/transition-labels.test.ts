// State, transition, and machine text comes from the contract (`x-state-machines`) and its Chinese
// overlay; the generator refuses an overlay that leaves any of it untranslated. What the console
// still has to guarantee is that it can tell apart transitions sharing a state pair, such as the
// two operator conclusions of a disconnected preparation, in every language.
import { expect, test } from 'vitest'

import { STATE_MACHINES_BY_LANGUAGE } from '../browser/features/runs/state-machines.generated.js'
import type { Language } from '../browser/shared/i18n.js'
import { edgeLabel } from '../browser/features/runs/detail/transitions.js'

test('transitions sharing a state pair retain distinct explanations in every language', () => {
  for (const language of ['en', 'zh'] as const satisfies Language[]) {
    for (const machine of STATE_MACHINES_BY_LANGUAGE[language]) {
      for (const body of [machine, machine.step]) {
        if (body === undefined) continue
        const groups = Map.groupBy(body.transitions, (edge) => `${edge.from}->${edge.to}`)
        for (const edges of groups.values()) {
          if (edges.length < 2) continue
          const labels: string[] = edges.map((edge) => edgeLabel(body, edge))
          expect(new Set(labels).size, labels.join(' | ')).toBe(edges.length)
        }
      }
    }
  }
})
