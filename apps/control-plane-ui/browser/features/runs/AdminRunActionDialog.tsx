import React from 'react'
import {
  Button,
  Group,
  Modal,
  Stack,
  Text,
  Textarea,
  TextInput
} from '@mantine/core'

import { useMessages, type Message } from '../../shared/i18n.js'
import { adminRunAction, type AdminRunAction } from './api.js'
import { abandonFailureMessageKey } from './format.js'

/** What one operator decision says about itself; everything else is shared. */
export interface AdminRunActionConfig {
  action: AdminRunAction
  title: Message
  explainer: Message
  /** A sentence this run's shape adds after the explainer, already translated. */
  extraExplainer?: string
  confirmLabel: Message
  /** A decision that concludes a run says so; a resumption does not. */
  confirmColor?: string
  /** Whether the decision records a written reason beside the credential. */
  requiresReason: boolean
  testId?: string
}

/**
 * One operator decision on a parked run.
 *
 * The credential is entered here, held only in this component's state, and sent with the single
 * request, so closing the dialog (or the tab) leaves nothing behind that could act later. Every
 * decision shares that rule, the reset-on-open, the submit state and the failure wording; a
 * caller supplies only what the decision says about itself.
 */
export function AdminRunActionDialog({
  runId,
  config,
  opened,
  onClose,
  onDone
}: {
  runId: string
  config: AdminRunActionConfig
  opened: boolean
  onClose: () => void
  onDone: () => void | Promise<void>
}): React.JSX.Element {
  const t = useMessages()
  const [reason, setReason] = React.useState('')
  const [adminToken, setAdminToken] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [failure, setFailure] = React.useState<string | null>(null)

  // Reset whenever the dialog opens for a different run, so a token typed for one decision is
  // never silently reused for the next.
  React.useEffect(() => {
    if (!opened) return
    setReason('')
    setAdminToken('')
    setFailure(null)
    setSubmitting(false)
  }, [opened, runId])

  const submit = async (): Promise<void> => {
    setSubmitting(true)
    setFailure(null)
    try {
      await adminRunAction(runId, config.action, {
        adminToken: adminToken.trim(),
        ...(config.requiresReason ? { reason: reason.trim() } : {})
      })
      await onDone()
    } catch (error) {
      setFailure(t(abandonFailureMessageKey(error)))
    } finally {
      setSubmitting(false)
    }
  }

  const incomplete =
    adminToken.trim() === '' || (config.requiresReason && reason.trim() === '')

  return (
    <Modal opened={opened} onClose={onClose} title={t(config.title)} centered>
      <Stack gap="sm">
        <Text size="sm">
          {t(config.explainer)}
          {config.extraExplainer && ` ${config.extraExplainer}`}
        </Text>
        <Text size="xs" ff="monospace" c="dimmed">
          {runId}
        </Text>
        {config.requiresReason && (
          <Textarea
            label={t('abandonReasonLabel')}
            description={t('abandonReasonHint')}
            value={reason}
            onChange={(event) => setReason(event.currentTarget.value)}
            autosize
            minRows={2}
            required
          />
        )}
        <TextInput
          label={t('abandonTokenLabel')}
          description={t('abandonTokenHint')}
          type="password"
          value={adminToken}
          onChange={(event) => setAdminToken(event.currentTarget.value)}
          required
        />
        {failure !== null && (
          <Text role="alert" c="red" size="sm">
            {failure}
          </Text>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            {...(config.confirmColor === undefined
              ? {}
              : { color: config.confirmColor })}
            loading={submitting}
            disabled={incomplete}
            onClick={() => {
              void submit()
            }}
            {...(config.testId === undefined
              ? {}
              : { 'data-testid': config.testId })}
          >
            {t(config.confirmLabel)}
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
