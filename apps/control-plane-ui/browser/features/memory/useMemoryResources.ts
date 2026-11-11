import React from 'react'
import { api } from '../../shared/api-client.js'
import { useResource, type Resource } from '../../shared/resource.js'
import { useRefresh, type RefreshState } from '../../shared/refresh.js'
import { usePagedResource, type PagedResource } from './usePagedResource.js'
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
  /** The newest revisions; the graph draws only this window. */
  latestRevisions: Resource<MemoryTreeRevisionList>
  /** One page of revision history for the list view. */
  revisionPages: PagedResource<null, number, MemoryTreeRevisionList>
  /** One page of observations, optionally filtered to one consuming revision. */
  observationPages: PagedResource<number | undefined, string, ObservationList>
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
  const latestRevisions = useResource((signal) =>
    api<MemoryTreeRevisionList>(
      `/memory/revisions?limit=${GRAPH_REVISION_WINDOW}`,
      { signal }
    )
  )
  const revisionPages = usePagedResource<null, number, MemoryTreeRevisionList>(
    { filter: null, limit: DEFAULT_PAGE_SIZE },
    ({ limit, trail }, signal) => {
      const query = new URLSearchParams({ limit: String(limit) })
      const before = trail.at(-1)
      if (before !== undefined) query.set('before_revision', String(before))
      return api<MemoryTreeRevisionList>(`/memory/revisions?${query}`, {
        signal
      })
    }
  )
  const observationPages = usePagedResource<
    number | undefined,
    string,
    ObservationList
  >(
    { filter: undefined, limit: DEFAULT_PAGE_SIZE },
    ({ filter, limit, trail }, signal) => {
      const query = new URLSearchParams({ limit: String(limit) })
      if (filter !== undefined) query.set('consumed_revision', String(filter))
      const cursor = trail.at(-1)
      if (cursor !== undefined) query.set('cursor', cursor)
      return api<ObservationList>(`/memory/observations?${query}`, { signal })
    }
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
      latestRevisions.reload(),
      revisionPages.resource.reload(),
      observationPages.resource.reload(),
      overview.reload()
    ])
  }, [
    automation.reload,
    latestRevisions.reload,
    observationPages.resource.reload,
    overview.reload,
    revisionPages.resource.reload,
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
    latestRevisions,
    revisionPages,
    observationPages,
    overview,
    overviewRange,
    changeOverviewRange,
    refresh,
    refreshing,
    lastChecked
  }
}

/** Matches the default the Runs list uses for its cursor pager. */
export const DEFAULT_PAGE_SIZE = 20
/** The graph draws one window of the newest revisions; older ones are in the list. */
export const GRAPH_REVISION_WINDOW = 50
