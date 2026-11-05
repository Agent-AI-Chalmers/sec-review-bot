import type React from 'react'
import { Text, Tooltip } from '@mantine/core'
import { useMessages } from '../../../shared/i18n.js'
import { failureCodeLabel } from '../format.js'

/** A failure code, with its meaning on hover when the console knows one.
 *
 * The code stays visible either way: it is what the logs and the Execution API use, and an operator
 * searching for it must not have to reconstruct it from a tooltip. A code the console does not
 * recognise renders plainly rather than being guessed at.
 */
export function ExplainedCode({
  code,
  className,
  tone = 'error',
  size = 'xs'
}: {
  code: string
  className?: string
  /** `error` for a failure code, `neutral` for a state marker that is not itself a failure. */
  tone?: 'error' | 'neutral'
  size?: 'xs' | 'sm'
}): React.JSX.Element {
  const t = useMessages()
  const { explanation } = failureCodeLabel(code, t)
  // Inline on purpose: as a block, a wrapping parent stretches this element to the row height
  // and the code no longer shares a baseline with the label beside it.
  const label = (
    <Text
      component="span"
      className={className}
      c={tone === 'error' ? 'var(--failure-text)' : 'var(--muted)'}
      size={size}
      ff="monospace"
    >
      {code}
    </Text>
  )
  if (explanation === null) return label
  return (
    <Tooltip
      label={explanation}
      multiline
      w={360}
      withArrow
      position="bottom-start"
      // Long enough to wrap to several lines; the default delay would make it feel broken.
      openDelay={150}
    >
      {label}
    </Tooltip>
  )
}
