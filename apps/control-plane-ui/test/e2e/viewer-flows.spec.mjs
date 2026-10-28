import { runViewerFlow } from '../browser-flows/viewer.mjs'
import { openAuthenticatedRuns, test } from './fixtures.ts'

test('viewer browser behavior', async ({ page }) => {
  await openAuthenticatedRuns(page)
  await runViewerFlow({ page })
})
