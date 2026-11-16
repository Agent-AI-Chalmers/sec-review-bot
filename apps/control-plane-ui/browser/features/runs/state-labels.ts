import type { Run, PublicationStep } from './api.js'
import { messages } from '../../shared/i18n.js'

type StateLabels = {
  [S in Run['preparation']['status'] as `state_preparation_${S}_label`]: string
} & {
  [S in Run['execution']['status'] as `state_execution_${S}_label`]: string
} & {
  [S in Run['publication']['status'] as `state_publication_${S}_label`]: string
} & {
  [
    S in PublicationStep['status'] as `state_publication_step_${S}_label`
  ]: string
}

// Both languages must cover the same API states; neither is a fallback for the other.
const stateLabels = {
  en: messages.en satisfies StateLabels,
  zh: messages.zh satisfies StateLabels
}

export type StateLabelKey = keyof StateLabels

export function isStateLabelKey(key: string): key is StateLabelKey {
  return (
    key.startsWith('state_') &&
    key.endsWith('_label') &&
    Object.hasOwn(stateLabels.en, key) &&
    Object.hasOwn(stateLabels.zh, key)
  )
}
