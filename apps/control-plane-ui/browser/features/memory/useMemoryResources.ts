import React from 'react'
import { api } from '../../shared/api-client.js'
import { useResource, type Resource } from '../../shared/resource.js'
import { useRefresh, type RefreshState } from '../../shared/refresh.js'
import type {
  MemoryTreeAutomation,
  MemoryTree,
  MemoryTreeRevisionList,
  ObservationList,
  CatalogOverview,
  GetCatalogOverviewQuery
} from './api-types.generated.js'

type OverviewRange = NonNullable<GetCatalogOverviewQuery['range']>

interface MemoryResources extends RefreshState {
  automation: Resource<MemoryTreeAutomation>
  tree: Resource<MemoryTree>
  revisions: Resource<MemoryTreeRevisionList>
  observations: Resource<ObservationList>
  overview: Resource<CatalogOverview>
  overviewRange: OverviewRange
  changeOverviewRange: (range: OverviewRange) => Promise<void>
}

/** Read catalog panels in one refresh cycle; range changes reload only the overview. */
export function useMemoryResources(): MemoryResources {
  // The selected range lives in a ref as well as in state: a reload has to read the range
  // the reader picked, not the one this render closed over.
  const overviewRangeRef = React.useRef<OverviewRange>('30d')
  const [overviewRange, setOverviewRange] = React.useState<OverviewRange>('30d')
  const automation = useResource((signal) =>
    api<MemoryTreeAutomation>('/memory/tree/automation', { signal })
  )
  const tree = useResource((signal) =>
    api<MemoryTree>('/memory/tree', { signal })
  )
  const revisions = useResource((signal) =>
    api<MemoryTreeRevisionList>('/memory/revisions?limit=50', { signal })
  )
  const observations = useResource((signal) =>
    api<ObservationList>('/memory/observations?limit=50', { signal })
  )
  const overview = useResource((signal) =>
    api<CatalogOverview>(`/memory/overview?range=${overviewRangeRef.current}`, {
      signal
    })
  )
  const load = React.useCallback(async (): Promise<void> => {
    await Promise.all([
      automation.reload(),
      tree.reload(),
      revisions.reload(),
      observations.reload(),
      overview.reload()
    ])
  }, [
    automation.reload,
    observations.reload,
    overview.reload,
    revisions.reload,
    tree.reload
  ])
  const { refresh, refreshing, lastChecked } = useRefresh(load)

  const changeOverviewRange = async (range: OverviewRange): Promise<void> => {
    setOverviewRange(range)
    overviewRangeRef.current = range
    await overview.reload()
  }

  return {
    automation,
    tree,
    revisions,
    observations,
    overview,
    overviewRange,
    changeOverviewRange,
    refresh,
    refreshing,
    lastChecked
  }
}
