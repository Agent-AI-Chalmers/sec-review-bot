import type { TrajectoryMessageView } from './trajectory-model.js'

export function scrollToTrajectoryElement(
  id: string,
  behavior?: ScrollBehavior
): void {
  document.getElementById(id)?.scrollIntoView({
    behavior:
      behavior ??
      (window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth'),
    block: 'center'
  })
}

export function messageKey(message: TrajectoryMessageView): string {
  return `${message.seq}:${message.id}:${message.role}`
}
