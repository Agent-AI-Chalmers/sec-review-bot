import React from 'react'
import {
  IconRobot,
  IconSettings,
  IconTool,
  IconUser
} from '@tabler/icons-react'

import { ICON_SIZE } from '../../shared/design.js'
import type { TrajectoryRole } from './trajectory-model.js'

export function rolePresentation(role: TrajectoryRole): {
  color: string
  icon: React.JSX.Element
  key:
    | 'trajectorySystem'
    | 'trajectoryHuman'
    | 'trajectoryAssistant'
    | 'trajectoryTool'
    | 'trajectoryUnknown'
} {
  if (role === 'system')
    return {
      color: 'gray',
      icon: <IconSettings size={ICON_SIZE.md} />,
      key: 'trajectorySystem'
    }
  if (role === 'human')
    return {
      color: 'orange',
      icon: <IconUser size={ICON_SIZE.md} />,
      key: 'trajectoryHuman'
    }
  if (role === 'assistant')
    return {
      color: 'blue',
      icon: <IconRobot size={ICON_SIZE.md} />,
      key: 'trajectoryAssistant'
    }
  if (role === 'tool')
    return {
      color: 'green',
      icon: <IconTool size={ICON_SIZE.md} />,
      key: 'trajectoryTool'
    }
  return {
    color: 'gray',
    icon: <IconSettings size={ICON_SIZE.md} />,
    key: 'trajectoryUnknown'
  }
}

export const TRAJECTORY_ROLES: TrajectoryRole[] = [
  'system',
  'human',
  'assistant',
  'tool',
  'unknown'
]
