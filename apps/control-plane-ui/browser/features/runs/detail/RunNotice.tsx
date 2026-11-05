import type React from 'react'
import { Anchor, Text } from '@mantine/core'
import type { Run } from '../api.js'
import { useMessages } from '../../../shared/i18n.js'

/** What the requester was told about this phase, shown inside that phase.
 *
 * Notices are of two kinds: a `failure` (the run really ended) and an `attention` (automation
 * stopped without a conclusion, so someone has to look). Only a failure may be worded as one;
 * an attention notice says the outcome is unconfirmed. The line belongs to the phase, not to the
 * run's footer: "the user was told" is part of what happened in preparation, execution, or
 * publication, and a separate line at the bottom detached it from the evidence above it. A
 * delivery that could not be completed is reported here too, because its absence is the
 * operator's problem to notice.
 */
export function RunNotice({
  notice
}: {
  notice: Run['notices'][number]
}): React.JSX.Element {
  const t = useMessages()
  // Phrased as "who knows", not as "a notice was delivered/failed": "Failure notice: delivery
  // failed" says the same thing twice and still leaves the reader asking whether anyone was told.
  const label =
    notice.kind === 'attention'
      ? notice.status === 'superseded'
        ? t('attentionNoticeSuperseded')
        : notice.status === 'delivered'
          ? t('attentionNoticeDelivered')
          : notice.status === 'failed'
            ? t('attentionNoticeNotDelivered')
            : t('attentionNoticeDelivering')
      : notice.status === 'delivered'
        ? t('failureNoticeDelivered')
        : notice.status === 'failed'
          ? t('failureNoticeNotDelivered')
          : t('failureNoticeDelivering')
  // Only a delivered notice has a comment to open; a failed or in-flight one has nothing to
  // link to, which is exactly when the reader needs to know the requester was never told.
  const href = notice.comment_url ?? undefined
  return (
    <Text
      className="failure-notice-line"
      size="xs"
      c={notice.status === 'failed' ? 'red' : 'dimmed'}
      data-testid="failure-notice"
    >
      {href === undefined ? (
        label
      ) : (
        <Anchor
          href={href}
          target="_blank"
          rel="noreferrer"
          size="xs"
          data-testid="failure-notice-link"
        >
          {notice.kind === 'attention'
            ? t('viewAttentionNotice')
            : t('viewFailureNotice')}
        </Anchor>
      )}
    </Text>
  )
}
