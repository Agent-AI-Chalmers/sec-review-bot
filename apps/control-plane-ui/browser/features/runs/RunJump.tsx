import React from 'react'
import { ActionIcon, Button, Group, Popover, TextInput } from '@mantine/core'
import { IconArrowRight } from '@tabler/icons-react'
import { useNavigate } from 'react-router-dom'

import { useMessages } from '../../shared/i18n.js'
import { ICON_SIZE } from '../../shared/design.js'

/** A compact run-id lookup; the header stays run-agnostic so Memory has no jump control. */
export function RunJump(): React.JSX.Element {
  const t = useMessages()
  const navigate = useNavigate()
  const [opened, setOpened] = React.useState(false)
  const [value, setValue] = React.useState('')
  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-end"
      width={300}
      shadow="md"
      withArrow
    >
      <Popover.Target>
        <Button
          type="button"
          variant="default"
          leftSection={<IconArrowRight size={ICON_SIZE.md} />}
          onClick={() => setOpened((current) => !current)}
        >
          {t('jumpToRun')}
        </Button>
      </Popover.Target>
      <Popover.Dropdown p="sm">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            const requestedRunId = value.trim()
            if (!requestedRunId) return
            setOpened(false)
            setValue('')
            navigate(`/runs/${encodeURIComponent(requestedRunId)}`)
          }}
        >
          <Group gap="xs" align="flex-end" wrap="nowrap">
            <TextInput
              label={t('goToRunId')}
              placeholder={t('runIdPlaceholder')}
              value={value}
              size="sm"
              autoFocus
              style={{ flex: 1 }}
              onChange={(event) => setValue(event.currentTarget.value)}
            />
            <ActionIcon
              type="submit"
              aria-label={t('goToRun')}
              variant="filled"
              size={36}
            >
              <IconArrowRight size={ICON_SIZE.md} />
            </ActionIcon>
          </Group>
        </form>
      </Popover.Dropdown>
    </Popover>
  )
}
