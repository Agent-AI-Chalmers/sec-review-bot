import React from 'react'
import { Tooltip } from '@mantine/core'
import {
  IconBrandGithub,
  IconBrandGitlab,
  IconSourceCode
} from '@tabler/icons-react'

import { ICON_SIZE } from '../../shared/design.js'

type PlatformMarkProps = {
  platform: string
  githubLabel: string
  gitlabLabel: string
  unknownLabel: string
  compactOnNarrow?: boolean
  size?: 'sm'
}

export function PlatformMark({
  platform,
  githubLabel,
  gitlabLabel,
  unknownLabel,
  compactOnNarrow = false,
  size
}: PlatformMarkProps): React.JSX.Element {
  const label =
    platform === 'github'
      ? githubLabel
      : platform === 'gitlab'
        ? gitlabLabel
        : platform === 'unknown'
          ? unknownLabel
          : platform
  const Icon =
    platform === 'github'
      ? IconBrandGithub
      : platform === 'gitlab'
        ? IconBrandGitlab
        : IconSourceCode

  return (
    <Tooltip label={label} disabled={!compactOnNarrow}>
      <span
        className={`platform-mark${compactOnNarrow ? ' platform-mark-compact' : ''}${size === 'sm' ? ' platform-mark-sm' : ''}`}
        role="img"
        aria-label={label}
      >
        <Icon size={ICON_SIZE.lg} stroke={1.8} aria-hidden="true" />
        <span className="platform-mark-label" aria-hidden="true">
          {label}
        </span>
      </span>
    </Tooltip>
  )
}
