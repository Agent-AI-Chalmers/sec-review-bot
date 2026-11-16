import React from 'react'
import { api } from '../../shared/api-client.js'
import { useResource, type Resource } from '../../shared/resource.js'
import { useRefresh, type RefreshState } from '../../shared/refresh.js'
import { usePagedResource, type PagedResource } from './usePagedResource.js'
import type {
  MemoryTreeAutomation,
  MemoryTree,
  MemoryTreeVersionList,
  ObservationList,
  CatalogOverview,
  GetCatalogOverviewQuery
} from './api-types.generated.js'

type OverviewRange = NonNullable<GetCatalogOverviewQuery['range']>

interface MemoryResources extends RefreshState {
  automation: Resource<MemoryTreeAutomation>
  tree: Resource<MemoryTree>
  /** The graph window, centered on a navigation target or starting at latest. */
  graphVersions: Resource<MemoryTreeVersionList>
  /** One page of version history for the list view. */
  versionPages: PagedResource<null, number, MemoryTreeVersionList>
  /** One page of observations, optionally filtered to one consuming version. */
  observationPages: PagedResource<number | undefined, string, ObservationList>
  graphTarget: number | undefined
  showGraph: (target?: number) => Promise<void>
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
  const graphTargetRef = React.useRef<number | undefined>(undefined)
  const [graphTarget, setGraphTarget] = React.useState<number>()
  const graphVersions = useResource(async (signal) => {
    const target = graphTargetRef.current
    if (target === undefined)
      return api<MemoryTreeVersionList>(
        `/memory/versions?limit=${GRAPH_VERSION_WINDOW}`,
        { signal }
      )
    const latest = await api<MemoryTreeVersionList>(
      '/memory/versions?limit=1',
      { signal }
    )
    const newest = latest.versions[0]?.version ?? 0
    // Catalog assigns contiguous versions with max(version) + 1 and retains history.
    // Prefer 25 newer and 24 older neighbors; transfer unused space at either end.
    const upper = Math.min(newest, Math.max(GRAPH_VERSION_WINDOW, target + 25))
    return api<MemoryTreeVersionList>(
      `/memory/versions?limit=${GRAPH_VERSION_WINDOW}&before_version=${upper + 1}`,
      { signal }
    )
  })
  const showGraph = async (target?: number): Promise<void> => {
    graphTargetRef.current = target
    setGraphTarget(target)
    await graphVersions.reload()
  }
  const versionPages = usePagedResource<null, number, MemoryTreeVersionList>(
    { filter: null, limit: DEFAULT_PAGE_SIZE },
    ({ limit, trail }, signal) => {
      const query = new URLSearchParams({ limit: String(limit) })
      const before = trail.at(-1)
      if (before !== undefined) query.set('before_version', String(before))
      return api<MemoryTreeVersionList>(`/memory/versions?${query}`, {
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
      if (filter !== undefined) query.set('consumed_version', String(filter))
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
      graphVersions.reload(),
      versionPages.resource.reload(),
      observationPages.resource.reload(),
      overview.reload()
    ])
  }, [
    automation.reload,
    graphVersions.reload,
    observationPages.resource.reload,
    overview.reload,
    versionPages.resource.reload,
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
    graphVersions,
    graphTarget,
    showGraph,
    versionPages,
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
/** Maximum number of versions drawn in a graph window. */
export const GRAPH_VERSION_WINDOW = 50
