import type { Page, BrowserContext } from '@playwright/test'
import type { ViteDevServer } from 'vite'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { expect } from '@playwright/test'

async function waitForCondition(predicate: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 5_000
  for (;;) {
    if (await predicate()) {
      return
    }
    if (Date.now() > deadline) {
      throw new Error(message)
    }
    await delay(50)
  }
}

export async function runMemoryPreflightFlow({
  name,
  context,
  base,
  server
}: {
  name: string
  context: BrowserContext
  base: string
  server: ViteDevServer | undefined
}) {
  if (name === 'desktop') {
    const aGate = Promise.withResolvers<void>()
    const bGate = Promise.withResolvers<void>()
    const aRequested = Promise.withResolvers<void>()
    const bRequested = Promise.withResolvers<void>()
    const aSettled = Promise.withResolvers<void>()
    const trajectoryResponse = (content: string) => ({
      events: [
        {
          seq: 1,
          event: 'message',
          message: {
            role: 'user',
            id: content.toLowerCase().replaceAll(' ', '-'),
            content,
            tool_calls: []
          }
        }
      ]
    })
    const racePage = await context.newPage()
    let aCancelled = false
    racePage.on('requestfailed', (request) => {
      if (request.url().endsWith('/memory/versions/1/trajectory/content')) {
        aCancelled = true
      }
    })
    await racePage.route('**/api/memory/versions/1/trajectory/content', async (route) => {
      aRequested.resolve()
      try {
        await aGate.promise
        await route.fulfill({
          json: trajectoryResponse('Trajectory target A')
        })
      } finally {
        aSettled.resolve()
      }
    })
    await racePage.route('**/api/memory/versions/2/trajectory/content', async (route) => {
      bRequested.resolve()
      await bGate.promise
      await route.fulfill({ json: trajectoryResponse('Trajectory target B') })
    })
    try {
      await racePage.goto(`${base}/memory/versions/1/trajectory`, {
        waitUntil: 'domcontentloaded'
      })
      // Loading UI alone does not prove A has reached the network interceptor.
      await aRequested.promise
      await expect(racePage.getByText('Loading…', { exact: true })).toBeVisible()
      await racePage.evaluate(() => {
        globalThis.history.pushState({}, '', '/memory/versions/2/trajectory')
        globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
      })
      await bRequested.promise
      aGate.resolve()
      await aSettled.promise
      await expect
        .poll(() => aCancelled, {
          message: 'Navigating to B must abort request A'
        })
        .toBe(true)
      // B remains blocked while the cancelled request settles; no elapsed-time guess.
      await expect(racePage.getByText('Loading…', { exact: true })).toBeVisible()
      await expect(racePage.getByText('Trajectory target A', { exact: true })).toHaveCount(0)
      bGate.resolve()
      await expect(racePage.getByText('Trajectory target B', { exact: true })).toBeVisible()
      await expect(racePage.getByText('Trajectory target A', { exact: true })).toHaveCount(0)
      await expect(racePage.getByRole('alert')).toHaveCount(0)
    } finally {
      aGate.resolve()
      bGate.resolve()
      await racePage.unrouteAll({ behavior: 'wait' })
      await racePage.close()
    }

    const trajectoryFailurePage = await context.newPage()
    await trajectoryFailurePage.route('**/api/memory/versions/1/trajectory/content', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"memory_catalog_unavailable"}'
      })
    )
    await trajectoryFailurePage.goto(`${base}/memory/versions/1/trajectory`, {
      waitUntil: 'domcontentloaded'
    })
    await trajectoryFailurePage
      .getByText('The trajectory could not be opened.', { exact: true })
      .waitFor()
    const centeredTrajectoryError = await trajectoryFailurePage.evaluate(() => {
      const state = document.querySelector('.content-load-state')
      const alert = state?.querySelector('[role="alert"]')
      if (!state || !alert) {
        return false
      }
      const stateRect = state.getBoundingClientRect()
      const alertRect = alert.getBoundingClientRect()
      return (
        Math.abs(alertRect.left + alertRect.width / 2 - (stateRect.left + stateRect.width / 2)) <
          1 &&
        Math.abs(alertRect.top + alertRect.height / 2 - (stateRect.top + stateRect.height / 2)) < 1
      )
    })
    assert.strictEqual(
      centeredTrajectoryError,
      true,
      'a full-page trajectory load error must be centered in its content region'
    )
    await trajectoryFailurePage.close()

    const memoryFilesFailurePage = await context.newPage()
    await memoryFilesFailurePage.route('**/api/memory/versions/1/content', (route) =>
      route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: '{"error":"invalid_memory_tree_artifact"}'
      })
    )
    await memoryFilesFailurePage.goto(`${base}/memory/versions/1/tree`, {
      waitUntil: 'domcontentloaded'
    })
    await memoryFilesFailurePage
      .getByText('The memory files could not be opened.', { exact: true })
      .waitFor()
    const memoryTreeDownload = memoryFilesFailurePage.getByRole('link', {
      name: 'Download memory tree'
    })
    await memoryTreeDownload.waitFor()
    assert.strictEqual(
      await memoryTreeDownload.getAttribute('href'),
      '/api/memory/versions/1/artifact',
      'a memory preview failure must preserve the original artifact download'
    )
    await memoryFilesFailurePage.close()

    if (server !== undefined) {
      const partialFailurePage = await context.newPage()
      await partialFailurePage.route('**/api/memory/overview*', (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: '{"error":"memory_catalog_unavailable"}'
        })
      )
      await partialFailurePage.goto(`${base}/memory`, {
        waitUntil: 'domcontentloaded'
      })
      await partialFailurePage
        .getByText('Memory overview could not be loaded.', { exact: true })
        .waitFor()
      await partialFailurePage.getByText('Auto-update', { exact: true }).waitFor()
      await partialFailurePage.getByText('Versions', { exact: true }).click()
      await partialFailurePage.locator('.version-graph-node').first().waitFor()
      await partialFailurePage.getByText('Observations', { exact: true }).click()
      await partialFailurePage.locator('tbody tr').first().waitFor()
      assert.ok(
        (await partialFailurePage.locator('tbody tr').count()) > 0,
        'an overview failure must not discard successfully loaded observations'
      )
      await partialFailurePage.unroute('**/api/memory/overview*')
      await partialFailurePage.getByText('Versions', { exact: true }).click()
      const loadedVersionCount = await partialFailurePage.locator('.version-graph-node').count()
      await partialFailurePage.route('**/api/memory/versions*', (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: '{"error":"memory_catalog_unavailable"}'
        })
      )
      await partialFailurePage.getByRole('button', { name: 'Refresh', exact: true }).click()
      await partialFailurePage
        .getByText('Version history could not be loaded.', { exact: true })
        .waitFor()
      assert.strictEqual(
        await partialFailurePage.locator('.version-graph-node').count(),
        loadedVersionCount,
        'a failed version refresh must preserve the last successful version history'
      )
      await partialFailurePage.close()

      const unknownCurrentPage = await context.newPage()
      await unknownCurrentPage.route('**/api/memory/tree', (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: '{"error":"memory_catalog_unavailable"}'
        })
      )
      await unknownCurrentPage.goto(`${base}/memory`, {
        waitUntil: 'domcontentloaded'
      })
      await unknownCurrentPage
        .getByText('The current memory version could not be loaded.', {
          exact: true
        })
        .waitFor()
      await unknownCurrentPage.getByText('Versions', { exact: true }).click()
      await unknownCurrentPage.locator('.version-graph-node').first().waitFor()
      assert.strictEqual(
        await unknownCurrentPage.locator('.version-graph-node[data-current]').count(),
        0,
        'unknown current version must not mark any graph node as current'
      )
      assert.strictEqual(
        await unknownCurrentPage.getByRole('button', { name: 'Set current', exact: true }).count(),
        0,
        'unknown current version must not expose set-current in the graph'
      )
      const listView = unknownCurrentPage.getByRole('radio', {
        name: 'List',
        exact: true
      })
      await unknownCurrentPage.getByText('List', { exact: true }).click()
      await waitForCondition(
        () => listView.isChecked(),
        'unknown current version list view did not become active'
      )
      assert.strictEqual(
        await unknownCurrentPage.locator('tr[aria-current="true"]').count(),
        0,
        'unknown current version must not mark any list row as current'
      )
      assert.strictEqual(
        await unknownCurrentPage.getByRole('button', { name: 'Set current', exact: true }).count(),
        0,
        'unknown current version must not expose set-current in the list'
      )
      assert.strictEqual(
        await unknownCurrentPage.getByText('Already current', { exact: true }).count(),
        0,
        'unknown current version must not invent an already-current state'
      )
      await unknownCurrentPage.close()
    }
  }
}

async function openVersionList(page: Page) {
  await page.goto('/memory', { waitUntil: 'domcontentloaded' })
  await page.getByRole('tab', { name: 'Versions', exact: true }).click()
  await page.getByText('List', { exact: true }).click()
}

export async function runMemoryChineseFlow({
  page,
  base,
  name
}: {
  page: Page
  base: string
  name: string
}) {
  // Other panels may settle first. Hold observations until their tab opens so
  // geometry checks must wait for this response, independently of overview data.
  const observations = Promise.withResolvers<void>()
  await page.route('**/api/memory/observations?*', async (route) => {
    await observations.promise
    await route.continue()
  })
  try {
    await page.addInitScript(() => localStorage.setItem('ui-language', 'zh'))
    await page.goto(`${base}/memory`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: '记忆' }).waitFor()
    const automationSwitch = page.getByRole('switch', {
      name: '自动更新'
    })
    await automationSwitch.waitFor()
    await page.getByRole('img', { name: '查看记忆自动更新说明' }).hover()
    const automationHelp = page.getByRole('tooltip')
    await automationHelp.waitFor()
    assert.ok(
      (await automationHelp.textContent())?.trim(),
      `${name} automation help tooltip must render its explanation`
    )
    await page.getByText('概览', { exact: true }).waitFor()
    await page
      .getByRole('region', { name: '概览' })
      .getByText('未产出观察项', { exact: true })
      .waitFor()
    await page.getByText('版本历史', { exact: true }).click()
    await page.getByText('列表', { exact: true }).click()
    await page.locator('tr[aria-current="true"]').waitFor()
    await page.getByText('版本历史', { exact: true }).waitFor()
    await page.getByText('观察项', { exact: true }).click()
    observations.resolve()
    await expect(page.locator('.memory-incorporation').first()).toBeVisible()
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const container = document.querySelector('.memory-incorporation')
            const label = container?.querySelector('span')
            const link = container?.querySelector('button')
            if (!container || !label || !link) {
              return false
            }
            return (
              Number.parseFloat(getComputedStyle(container).columnGap) > 0 &&
              getComputedStyle(label).fontSize === getComputedStyle(link).fontSize
            )
          }),
        {
          message: 'Chinese incorporated version text must share typography and a real gap'
        }
      )
      .toBe(true)
    await page
      .locator('.mantine-Tabs-panel:visible')
      .getByRole('button', { name: '轨迹' })
      .first()
      .click()
    const zhExtractionDialog = page.getByRole('dialog', {
      name: '记忆提取 Agent 轨迹'
    })
    await zhExtractionDialog.waitFor()
    await zhExtractionDialog.locator('.mantine-Modal-close').click()
    await page.getByRole('button', { name: '编辑当前记忆' }).waitFor()
  } finally {
    observations.resolve()
    await page.unrouteAll({ behavior: 'wait' })
  }
}

export async function runMemoryOverviewFlow({
  page,
  name,
  waitUntil
}: {
  page: Page
  name: string
  waitUntil: (
    predicate: () => boolean | Promise<boolean>,
    message: string,
    options?: { timeoutMs?: number; intervalMs?: number }
  ) => Promise<void>
}) {
  const memoryEndpoints = [
    '/api/memory/tree/automation',
    '/api/memory/tree',
    '/api/memory/versions',
    '/api/memory/observations',
    '/api/memory/overview'
  ]
  const memoryRequestCounts = Object.fromEntries(memoryEndpoints.map((endpoint) => [endpoint, 0]))
  const countMemoryRequest = (request: import('@playwright/test').Request) => {
    const pathname = new URL(request.url()).pathname
    const endpoint = memoryEndpoints.find(
      (candidate) => pathname === candidate || pathname.startsWith(`${candidate}/`)
    )
    if (endpoint !== undefined) {
      memoryRequestCounts[endpoint] += 1
    }
  }
  page.on('request', countMemoryRequest)
  await page.getByRole('link', { name: 'Memory' }).click()
  await page.getByRole('heading', { name: 'Memory' }).waitFor()
  assert.strictEqual(
    await page.getByLabel('Go to run ID').count(),
    0,
    `${name} run navigation must not appear on the memory page`
  )
  await page.getByRole('button', { name: 'Refresh', exact: true }).waitFor({ state: 'visible' })
  await waitUntil(
    async () => !(await page.getByRole('button', { name: 'Refresh', exact: true }).isDisabled()),
    `${name} memory refresh must settle`
  )
  await page.getByText('Overview', { exact: true }).waitFor()
  await page
    .getByRole('region', { name: 'Overview' })
    .getByText('No observation', { exact: true })
    .waitFor()
  const initialMemoryRequestCounts = { ...memoryRequestCounts }
  await page.getByText('90 days', { exact: true }).click()
  await waitUntil(
    async () =>
      memoryRequestCounts['/api/memory/overview'] ===
      initialMemoryRequestCounts['/api/memory/overview'] + 1,
    `${name} the 90-day range must request only a new overview`
  )
  await page.getByText('All', { exact: true }).click()
  await waitUntil(
    async () =>
      memoryRequestCounts['/api/memory/overview'] ===
      initialMemoryRequestCounts['/api/memory/overview'] + 2,
    `${name} the all-time range must request only a new overview`
  )
  await page.getByText('30 days', { exact: true }).click()
  await waitUntil(
    async () =>
      memoryRequestCounts['/api/memory/overview'] ===
      initialMemoryRequestCounts['/api/memory/overview'] + 3,
    `${name} returning to 30 days must request only a new overview`
  )
  for (const endpoint of memoryEndpoints.slice(0, -1)) {
    assert.strictEqual(
      memoryRequestCounts[endpoint],
      initialMemoryRequestCounts[endpoint],
      `${name} overview range changes must not request ${endpoint}`
    )
  }
  page.off('request', countMemoryRequest)
}

export async function runMemoryVersionFlow({
  page,
  name,
  viewport,
  screenshotPath
}: {
  page: Page
  name: string
  viewport: { width: number; height: number } | null
  screenshotPath: string
}) {
  assert.ok(viewport, 'Browser flow requires a viewport')
  await page.goto('/memory', { waitUntil: 'domcontentloaded' })
  await page.getByText('Versions', { exact: true }).click()
  await expect(page.locator('[data-version-node="56"]')).toBeVisible()
  const versionGraphLayout = await page.evaluate(() => {
    const box = (version: number) => {
      const node = document.querySelector(`.version-graph-node[data-version-node="${version}"]`)
      if (node === null) {
        return null
      }
      const bounds = node.getBoundingClientRect()
      return { x: bounds.x, y: bounds.y }
    }
    return { version3: box(56), version2: box(54), version1: box(53) }
  })
  assert.ok(
    versionGraphLayout.version3 !== null &&
      versionGraphLayout.version2 !== null &&
      versionGraphLayout.version1 !== null &&
      versionGraphLayout.version3.y < versionGraphLayout.version2.y &&
      versionGraphLayout.version2.y < versionGraphLayout.version1.y &&
      versionGraphLayout.version3.x !== versionGraphLayout.version2.x,
    `${name} version graph must place newer versions above their shared predecessor and expose the branch: ${JSON.stringify(versionGraphLayout)}`
  )
  if (viewport.width >= 768) {
    const graphCentering = await page.evaluate(() => {
      const viewport = document.querySelector('.version-graph-scroll')
      const graph = document.querySelector('.version-graph')
      if (!viewport || !graph) {
        return null
      }
      const viewportBox = viewport.getBoundingClientRect()
      const graphBox = graph.getBoundingClientRect()
      return {
        viewportCenter: viewportBox.left + viewportBox.width / 2,
        graphCenter: graphBox.left + graphBox.width / 2
      }
    })
    assert.ok(
      graphCentering !== null &&
        Math.abs(graphCentering.viewportCenter - graphCentering.graphCenter) < 2,
      `${name} a graph narrower than its viewport must start centered: ${JSON.stringify(graphCentering)}`
    )
  }
  assert.strictEqual(
    await page.locator('.version-graph-node[data-current]').count(),
    1,
    `${name} version graph must mark exactly one active version`
  )
  if (name === 'desktop') {
    assert.strictEqual(
      await page.locator('.version-graph-node[data-current]').getAttribute('data-version-node'),
      '59',
      `${name} initial graph must distinguish the active version from the newest version`
    )
  }
  await page.getByText('List', { exact: true }).click()
  await page
    .locator('tr[aria-current="true"]')
    .getByText('Already current', { exact: true })
    .waitFor()
  await page.screenshot({
    path: screenshotPath,
    fullPage: true
  })
  const memoryBody = await page.locator('body').boundingBox()
  assert.ok(
    memoryBody !== null && memoryBody.width <= viewport.width + 1,
    `${name} memory layout overflows horizontally`
  )
  if (viewport.width <= 600) {
    const list = page.locator('.memory-table:visible')
    assert.ok(
      await list.evaluate((element) => element.scrollWidth <= element.clientWidth),
      `${name} mobile versions must keep identity and actions inside each card`
    )
  } else {
    const versionColumnLayout = await page.evaluate(() => {
      const version = document.querySelector('.memory-version-cell')
      const predecessor = document.querySelector('.memory-predecessor-cell')
      if (version === null || predecessor === null) {
        return null
      }
      return {
        versionWidth: version.getBoundingClientRect().width,
        predecessorWidth: predecessor.getBoundingClientRect().width,
        versionAlign: getComputedStyle(version).textAlign,
        predecessorAlign: getComputedStyle(predecessor).textAlign
      }
    })
    assert.deepStrictEqual(
      versionColumnLayout,
      {
        versionWidth: 120,
        predecessorWidth: 120,
        versionAlign: 'center',
        predecessorAlign: 'center'
      },
      `${name} version and predecessor columns must share centered numeric layout`
    )
    const currentActionLayout = await page.evaluate(() =>
      [...document.querySelectorAll('.memory-current-action')].map((button) => {
        const icon = button.querySelector('svg')
        return {
          left: button.getBoundingClientRect().left,
          width: button.getBoundingClientRect().width,
          iconOffset:
            icon === null
              ? null
              : icon.getBoundingClientRect().left - button.getBoundingClientRect().left
        }
      })
    )
    assert.ok(
      currentActionLayout.length >= 2 &&
        currentActionLayout.every(
          (layout) =>
            Math.abs(layout.left - currentActionLayout[0].left) < 2 &&
            layout.width === currentActionLayout[0].width &&
            Math.abs((layout.iconOffset ?? 0) - (currentActionLayout[0].iconOffset ?? 0)) < 2
        ),
      `${name} set-current and already-current actions must keep the same geometry: ${JSON.stringify(currentActionLayout)}`
    )
  }
}

export async function runMemoryFilesFlow({
  page,
  context,
  base,
  name,
  viewport
}: {
  page: Page
  context: BrowserContext
  base: string
  name: string
  viewport: { width: number; height: number } | null
}) {
  assert.ok(viewport, 'Browser flow requires a viewport')
  await openVersionList(page)
  await page.getByRole('combobox', { name: 'Rows per page', exact: true }).click()
  await page.getByRole('option', { name: '100', exact: true }).click()
  const versionTwoRow = page.locator('tbody tr').filter({
    has: page.locator('.memory-version-cell', { hasText: /^2$/ })
  })
  await versionTwoRow.getByRole('button', { name: 'Files' }).click()
  const treeDialog = page.getByRole('dialog', {
    name: /Memory files · version/
  })
  await treeDialog.getByText('Security Review Experience Memory').waitFor()
  const treeSplitter = treeDialog.getByRole('separator', {
    name: 'Resize file tree'
  })
  if (viewport.width >= 768) {
    const splitterBox = await treeSplitter.boundingBox()
    assert.ok(splitterBox !== null, `${name} file tree splitter must be visible`)
    const filePane = treeDialog.locator('.file-workspace-sidebar')
    const originalWidth = (await filePane.boundingBox())?.width ?? 0
    await page.mouse.move(
      splitterBox.x + splitterBox.width / 2,
      splitterBox.y + splitterBox.height / 2
    )
    await page.mouse.down()
    await page.mouse.move(
      splitterBox.x + splitterBox.width / 2 + 80,
      splitterBox.y + splitterBox.height / 2
    )
    await page.mouse.up()
    const resizedWidth = (await filePane.boundingBox())?.width ?? 0
    assert.ok(
      resizedWidth >= originalWidth + 70,
      `${name} file tree splitter must resize the file pane`
    )
    await treeDialog.locator('.mantine-Modal-close').click()
    await versionTwoRow.getByRole('button', { name: 'Files' }).click()
    await page
      .getByRole('dialog', { name: /Memory files · version/ })
      .getByText('Security Review Experience Memory')
      .waitFor()
    const restoredWidth =
      (
        await page
          .getByRole('dialog', { name: /Memory files · version/ })
          .locator('.file-workspace-sidebar')
          .boundingBox()
      )?.width ?? 0
    assert.ok(
      Math.abs(restoredWidth - resizedWidth) < 2,
      `${name} file tree width must persist between viewer sessions`
    )
  } else {
    assert.strictEqual(
      await treeSplitter.isVisible(),
      false,
      `${name} file tree splitter must stay hidden in the stacked layout`
    )
  }
  await treeDialog.getByRole('link', { name: 'Authentication comparisons' }).click()
  await treeDialog.getByText('Constant-time comparison', { exact: true }).waitFor()
  await treeDialog.getByRole('button', { name: 'MEMORY.md' }).click()
  await treeDialog.getByText('Source', { exact: true }).click()
  await treeDialog.getByText('# Security Review Experience Memory', { exact: false }).waitFor()
  await treeDialog.locator('.mantine-Modal-close').click()

  await versionTwoRow.getByRole('button', { name: 'Changes' }).click()
  const diffDialog = page.getByRole('dialog', {
    name: /Compare version 2 with version 1/
  })
  await diffDialog.locator('.memory-diff-editor .cm-editor').first().waitFor()
  const diffTitleLayout = await diffDialog.locator('.memory-diff-title').evaluate((title) => ({
    parts: [...title.children].map((part) => part.textContent),
    gap: Number.parseFloat(getComputedStyle(title).columnGap)
  }))
  assert.deepStrictEqual(
    diffTitleLayout.parts,
    ['Compare', 'version 2', 'with', 'version 1'],
    `${name} version diff title must render semantic parts in language order`
  )
  assert.ok(diffTitleLayout.gap > 0, `${name} version diff title spacing must come from layout gap`)
  assert.strictEqual(
    await diffDialog.getByText('Preview', { exact: true }).count(),
    0,
    `${name} version diff must not expose the file preview mode`
  )
  assert.strictEqual(
    await diffDialog.getByText('Source', { exact: true }).count(),
    0,
    `${name} version diff must not expose the file source mode`
  )
  assert.ok(
    (await diffDialog.locator('.file-workspace-marker').count()) > 0,
    `${name} version diff must mark changed files`
  )
  assert.strictEqual(
    await diffDialog.getByRole('link', { name: 'Open in new page' }).getAttribute('href'),
    '/memory/versions/2/diff',
    `${name} version diff must expose a stable full-page URL`
  )
  await diffDialog.getByText('Unified', { exact: true }).click()
  await diffDialog.locator('.memory-diff-editor > .cm-editor').waitFor()
  await diffDialog.locator('.mantine-Modal-close').click()
  const diffPage = await context.newPage()
  await diffPage.goto(`${base}/memory/versions/2/diff`, {
    waitUntil: 'domcontentloaded'
  })
  await diffPage.getByRole('heading', { name: 'Compare version 2 with version 1' }).waitFor()
  await diffPage.locator('.memory-diff-editor .cm-editor').first().waitFor()
  await diffPage.close()
}

export async function runMemoryTrajectoryFlow({
  page,
  name,
  viewport,
  waitUntil
}: {
  page: Page
  name: string
  viewport: { width: number; height: number } | null
  waitUntil: (
    predicate: () => boolean | Promise<boolean>,
    message: string,
    options?: { timeoutMs?: number; intervalMs?: number }
  ) => Promise<void>
}) {
  assert.ok(viewport, 'Browser flow requires a viewport')
  await openVersionList(page)
  await page.getByRole('button', { name: 'Trajectory' }).first().click()
  const maintenanceDialog = page.getByRole('dialog', {
    name: 'Memory maintainer trajectory'
  })
  await maintenanceDialog
    .locator('.trajectory-message')
    .getByText('System', { exact: true })
    .waitFor()
  await maintenanceDialog
    .locator('.trajectory-message')
    .getByText('Assistant', { exact: true })
    .waitFor()
  const trajectoryLayout = await maintenanceDialog.evaluate((dialog) => {
    const layout = dialog.querySelector('.trajectory-layout')
    const timeline = dialog.querySelector('.trajectory-timeline')
    const minimap = dialog.querySelector('.trajectory-minimap')
    const body = dialog.querySelector('.mantine-Modal-body')
    if (layout === null || timeline === null || body === null) {
      return null
    }
    return {
      layoutWidth: layout.getBoundingClientRect().width,
      timelineWidth: timeline.getBoundingClientRect().width,
      minimapWidth: minimap?.getBoundingClientRect().width ?? 0,
      minimapPresent: minimap !== null,
      gap: Number.parseFloat(getComputedStyle(layout).columnGap) || 0,
      bodyWidth: body.getBoundingClientRect().width
    }
  })
  assert.ok(
    trajectoryLayout !== null && trajectoryLayout.layoutWidth >= trajectoryLayout.bodyWidth - 48,
    `${name} trajectory layout must fill the modal content width`
  )
  assert.ok(
    trajectoryLayout !== null &&
      trajectoryLayout.timelineWidth >=
        trajectoryLayout.layoutWidth - trajectoryLayout.minimapWidth - trajectoryLayout.gap - 1,
    `${name} trajectory timeline must fill the column next to the minimap`
  )
  assert.strictEqual(
    trajectoryLayout?.minimapPresent,
    viewport.width > 700,
    `${name} trajectory minimap must be mounted only when its rail has room`
  )
  await waitUntil(
    () =>
      maintenanceDialog.evaluate((dialog) => {
        const minimap = dialog.querySelector('.trajectory-minimap')
        if (minimap === null) {
          return true
        }
        let scroller = minimap.parentElement
        while (scroller !== null && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
          scroller = scroller.parentElement
        }
        if (scroller === null) {
          return false
        }
        const rail = minimap.getBoundingClientRect()
        const port = scroller.getBoundingClientRect()
        return Math.abs(rail.top + rail.height / 2 - (port.top + port.height / 2)) < 8
      }),
    `${name} trajectory rail must center in the modal scrollport`
  )
  await maintenanceDialog
    .getByPlaceholder('Search messages, tools, and arguments')
    .fill('current memory')
  await waitUntil(
    async () => (await maintenanceDialog.locator('.trajectory-message').count()) === 1,
    `${name} trajectory search must filter messages`
  )
  assert.strictEqual(
    await maintenanceDialog.locator('mark').textContent(),
    'current memory',
    `${name} trajectory search must highlight the matching text`
  )
  const fullTrajectoryHref = await maintenanceDialog
    .getByRole('link', { name: 'Open in new page' })
    .getAttribute('href')
  assert.match(
    fullTrajectoryHref ?? '',
    /^\/memory\/versions\/\d+\/trajectory$/,
    `${name} trajectory modal must expose a dedicated page`
  )
  await maintenanceDialog.getByPlaceholder('Search messages, tools, and arguments').fill('')
  await maintenanceDialog.getByRole('button', { name: 'Expand all' }).click()
  await maintenanceDialog.getByRole('button', { name: 'Collapse all' }).click()
  await maintenanceDialog.locator('.mantine-Modal-close').click()
  await maintenanceDialog.waitFor({ state: 'hidden' })

  assert.strictEqual(
    await page
      .locator('.mantine-Tabs-panel:visible')
      .getByRole('link', { name: /Download (memory tree|trajectory)/ })
      .count(),
    0,
    `${name} version rows must keep downloads inside their viewers`
  )
  const observationsTab = page.getByRole('tab', {
    name: 'Observations',
    exact: true
  })
  await observationsTab.click()
  await waitUntil(
    async () => (await observationsTab.getAttribute('aria-selected')) === 'true',
    `${name} observations tab did not become active`
  )
  const observationIndex = page.locator('tbody .memory-observation-index').first()
  await observationIndex.waitFor()
  assert.strictEqual(
    (await observationIndex.textContent())?.trim(),
    '1',
    `${name} observation rows must use a content-independent display index`
  )
  const sourceRunLink = page
    .locator('.mantine-Tabs-panel:visible tbody tr')
    .first()
    .getByRole('link')
  assert.match(
    (await sourceRunLink.getAttribute('href')) ?? '',
    /^\/runs\/[0-9a-f-]+$/,
    `${name} every observation must link to its source run`
  )
  await page.getByRole('combobox', { name: 'Rows per page', exact: true }).click()
  await page.getByRole('option', { name: '100', exact: true }).click()
  // Several fixture observations were consumed by the same version.
  const incorporatedVersion = page.getByRole('button', { name: 'version 2', exact: true }).first()
  await incorporatedVersion.click()
  const linkedVersionNode = page.locator('.version-graph-node[data-version-node="2"]')
  await waitUntil(
    async () =>
      (await page.getByRole('tab', { name: 'Versions' }).getAttribute('aria-selected')) ===
        'true' &&
      (await page.getByRole('radio', { name: 'Graph' }).isChecked()) &&
      (await linkedVersionNode.evaluate(
        (node) =>
          document.activeElement === node &&
          node.hasAttribute('data-selected') &&
          node.hasAttribute('data-highlighted')
      )),
    `${name} incorporated version link must reveal and highlight its graph node`
  )
  await observationsTab.click()
  await waitUntil(
    async () => (await observationsTab.getAttribute('aria-selected')) === 'true',
    `${name} observations tab did not become active again`
  )
  assert.strictEqual(
    await page
      .locator('.mantine-Tabs-panel:visible')
      .getByRole('link', { name: 'Download trajectory' })
      .count(),
    0,
    `${name} observation rows must not duplicate trajectory downloads`
  )
  await page
    .locator('.mantine-Tabs-panel:visible')
    .getByRole('button', { name: 'Trajectory' })
    .first()
    .click()
  const extractionDialog = page.getByRole('dialog', {
    name: 'Memory extractor trajectory'
  })
  await waitUntil(
    async () =>
      (await extractionDialog.locator('.trajectory-message').count()) === 4 &&
      (await extractionDialog.locator('.trajectory-tool').count()) === 1,
    `${name} extraction trajectory must render all messages and its tool result`
  )
  await extractionDialog.locator('.mantine-Modal-close').click()
  await page.getByText('Versions', { exact: true }).click()
  await page.getByText('List', { exact: true }).click()
}

export async function runMemoryEditFlow({
  page,
  name,
  viewport,
  waitUntil
}: {
  page: Page
  name: string
  viewport: { width: number; height: number } | null
  waitUntil: (
    predicate: () => boolean | Promise<boolean>,
    message: string,
    options?: { timeoutMs?: number; intervalMs?: number }
  ) => Promise<void>
}) {
  assert.ok(viewport, 'Browser flow requires a viewport')
  await openVersionList(page)
  await page.getByRole('combobox', { name: 'Rows per page', exact: true }).click()
  await page.getByRole('option', { name: '100', exact: true }).click()
  const currentVersion = (
    (await page.locator('tr[aria-current="true"] .memory-version-cell').textContent()) ?? ''
  ).trim()
  if (currentVersion !== '1') {
    const versionOneRow = page.locator('tbody tr').filter({
      has: page.locator('.memory-version-cell', { hasText: /^1$/ })
    })
    await versionOneRow.getByRole('button', { name: 'Set current' }).click()
    const restoreDialog = page.getByRole('dialog')
    await restoreDialog
      .getByText(/This immediately changes the active memory to version 1\./)
      .waitFor()
    await restoreDialog.getByRole('button', { name: 'Set as current' }).click()
  }
  await waitUntil(
    async () =>
      (
        (await page.locator('tr[aria-current="true"] .memory-version-cell').textContent()) ?? ''
      ).trim() === '1',
    `${name} restoring version 1 must move the active pointer to version 1`
  )
  const versionBefore = Number(
    ((await page.locator('tbody tr:first-child .memory-version-cell').textContent()) ?? '').match(
      /^\d+/
    )?.[0]
  )
  await page.getByRole('button', { name: 'Edit current memory' }).click()
  const editDialog = page.getByRole('dialog', { name: 'Edit memory files' })
  await editDialog.getByRole('button', { name: 'MEMORY.md' }).waitFor()
  const editorHeight = (await editDialog.getByLabel('Workspace editor').boundingBox())?.height ?? 0
  assert.ok(
    editorHeight >= (viewport.width >= 768 ? 360 : 300),
    `${name} memory editor must fill the available workspace height: ${editorHeight}`
  )
  await editDialog.getByText('Preview', { exact: true }).click()
  await editDialog.getByText('Security Review Experience Memory').waitFor()
  await editDialog.getByText('Edit', { exact: true }).click()
  const editor = editDialog.getByLabel('Workspace editor')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('\nEdited in browser flow.\n')
  assert.strictEqual(
    await editDialog.locator('.file-workspace-file[data-modified]').count(),
    1,
    `${name} edited memory file must be marked in the file tree`
  )
  await editDialog.getByRole('button', { name: 'New file' }).click()
  await page.getByLabel('File path').fill('topics/new.md')
  await page.getByRole('button', { name: 'Confirm' }).click()
  await editDialog.getByRole('button', { name: 'new.md' }).waitFor()
  await editDialog.getByRole('button', { name: 'Rename file' }).click()
  await page.getByLabel('File path').fill('topics/renamed.md')
  await page.getByRole('button', { name: 'Confirm' }).click()
  await editDialog.getByRole('button', { name: 'renamed.md' }).waitFor()
  await editDialog.getByRole('button', { name: 'Delete file' }).click()
  await page
    .getByRole('dialog', { name: 'Delete file' })
    .getByRole('button', { name: 'Delete' })
    .click()
  await editDialog.getByRole('button', { name: 'renamed.md' }).waitFor({ state: 'hidden' })
  assert.strictEqual(
    await editDialog.getByRole('button', { name: 'renamed.md' }).count(),
    0,
    `${name} memory workspace must delete an uncommitted file`
  )
  await editDialog.getByRole('button', { name: 'Cancel' }).click()
  const discardDialog = page.getByRole('dialog', {
    name: 'Discard memory changes?'
  })
  await discardDialog.getByText('Your edits have not been committed and will be lost.').waitFor()
  await discardDialog.getByRole('button', { name: 'Continue editing' }).click()
  const editRequests: unknown[] = []
  await page.route('**/api/memory/edit', async (route) => {
    editRequests.push(route.request().postDataJSON())
    if (editRequests.length === 1) {
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: '{"error":"memory_catalog_unavailable"}'
      })
    } else {
      await route.continue()
    }
  })
  await editDialog.getByRole('button', { name: 'Commit version' }).click()
  await page.getByText('The edit could not be committed.', { exact: true }).waitFor()
  await editDialog.getByRole('button', { name: 'Commit version' }).click()
  await waitUntil(async () => editRequests.length === 2, `${name} edit retry must be submitted`)
  assert.deepStrictEqual(
    editRequests[0],
    editRequests[1],
    `${name} edit retry must reuse its operation ID and original version`
  )
  await page.unroute('**/api/memory/edit')
  await waitUntil(
    async () =>
      (
        (await page.locator('tbody tr:first-child .memory-version-cell').textContent()) ?? ''
      ).startsWith(String(versionBefore + 1)),
    `${name} committed memory version must become current`
  )
  assert.strictEqual(
    (await page.locator('tbody tr:first-child .memory-predecessor-cell').textContent())?.trim(),
    '1',
    `${name} a new version after restore must retain version 1 as its predecessor`
  )
}
