import React from 'react'

import {
  api,
  isAbortError,
  throwIfUnauthorized
} from '../../shared/api-client.js'
import { ResourceLoadError } from '../../shared/ResourceLoadError.js'
import { useMessages } from '../../shared/i18n.js'
import { LatestRequestGuard } from '../../shared/latest-request.js'
import { LoadingState } from '../../shared/StateMessage.js'
import type { TrajectoryEvent } from './trajectory-model.js'
import type { MinimapPlacement } from './TrajectoryMinimap.js'
import { TrajectoryTimeline } from './TrajectoryTimeline.js'

export function TrajectoryContent({
  contentHref,
  minimapPlacement = 'viewport'
}: {
  contentHref: string
  minimapPlacement?: MinimapPlacement
}): React.JSX.Element {
  const t = useMessages()
  const [events, setEvents] = React.useState<TrajectoryEvent[]>([])
  const [error, setError] = React.useState<unknown>()
  const [loading, setLoading] = React.useState(false)
  const requests = React.useRef(new LatestRequestGuard())
  React.useEffect(() => {
    const request = requests.current.begin()
    setEvents([])
    setLoading(true)
    setError(undefined)
    void api<{ events: TrajectoryEvent[] }>(contentHref, {
      signal: request.signal
    })
      .then((body) => {
        if (request.isCurrent()) setEvents(body.events)
      })
      .catch((failure: unknown) => {
        if (request.isCurrent() && !isAbortError(failure)) setError(failure)
      })
      .finally(() => {
        if (request.isCurrent()) setLoading(false)
      })
    return request.cancel
  }, [t, contentHref])
  throwIfUnauthorized(error)
  if (error !== undefined)
    return (
      <div className="content-load-state">
        <ResourceLoadError message={t('trajectoryLoadFailed')} />
      </div>
    )
  if (loading) return <LoadingState message={t('loading')} />
  return (
    <TrajectoryTimeline events={events} minimapPlacement={minimapPlacement} />
  )
}
