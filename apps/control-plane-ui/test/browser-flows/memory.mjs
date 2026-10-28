import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

export async function runMemoryPreflightFlow({ name, context, base, server }) {
  if (name === 'desktop') {
    let releaseA
    let releaseB
    let markBRequested
    let markASettled
    const aGate = new Promise((resolve) => {
      releaseA = resolve
    })
    const bGate = new Promise((resolve) => {
      releaseB = resolve
    })
    const bRequested = new Promise((resolve) => {
      markBRequested = resolve
    })
    const aSettled = new Promise((resolve) => {
      markASettled = resolve
    })
    const transcriptResponse = (content) => ({
      events: [
        {
          seq: 1,
          event: 'message',
          message: {
            type: 'human',
            id: content.toLowerCase().replaceAll(' ', '-'),
            content,
            tool_calls: []
          }
        }
      ]
    })
    const racePage = await context.newPage()
    await racePage.route(
      '**/api/memory/revisions/1/transcript/content',
      async (route) => {
        try {
          await aGate
          await route
            .fulfill({ json: transcriptResponse('Transcript target A') })
            .catch(() => undefined)
        } finally {
          markASettled()
        }
      }
    )
    await racePage.route(
      '**/api/memory/revisions/2/transcript/content',
      async (route) => {
        markBRequested()
        await bGate
        await route.fulfill({
          json: transcriptResponse('Transcript target B')
        })
      }
    )
    await racePage.goto(`${base}/memory/revisions/1/transcript`, {
      waitUntil: 'domcontentloaded'
    })
    await racePage.getByText('Loading…', { exact: true }).waitFor()
    await racePage.evaluate(() => {
      globalThis.history.pushState({}, '', '/memory/revisions/2/transcript')
      globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'))
    })
    await bRequested
    await racePage.getByText('Loading…', { exact: true }).waitFor()
    await delay(50)
    assert.strictEqual(
      await racePage.getByText('Loading…', { exact: true }).isVisible(),
      true,
      'an aborted transcript request must not clear the next target loading state'
    )
    releaseB()
    await racePage.getByText('Transcript target B', { exact: true }).waitFor()
    assert.strictEqual(
      await racePage.getByText('Transcript target A', { exact: true }).count(),
      0,
      'a delayed transcript response must not overwrite the current target'
    )
    releaseA()
    await aSettled
    assert.strictEqual(
      await racePage
        .getByText('Transcript target B', { exact: true })
        .isVisible(),
      true,
      'the current transcript must remain visible after the stale handler settles'
    )
    assert.strictEqual(
      await racePage.getByText('Transcript target A', { exact: true }).count(),
      0,
      'the settled stale handler must not replace the current transcript'
    )
    assert.strictEqual(
      await racePage.getByRole('alert').count(),
      0,
      'the settled stale handler must not surface an error'
    )
    await racePage.close()

    const transcriptFailurePage = await context.newPage()
    await transcriptFailurePage.route(
      '**/api/memory/revisions/1/transcript/content',
      (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: '{"error":"memory_catalog_unavailable"}'
        })
    )
    await transcriptFailurePage.goto(`${base}/memory/revisions/1/transcript`, {
      waitUntil: 'domcontentloaded'
    })
    await transcriptFailurePage
      .getByText('The process transcript could not be opened.', { exact: true })
      .waitFor()
    const centeredTranscriptError = await transcriptFailurePage.evaluate(() => {
      const state = document.querySelector('.content-load-state')
      const alert = state?.querySelector('[role="alert"]')
      if (!state || !alert) return false
      const stateRect = state.getBoundingClientRect()
      const alertRect = alert.getBoundingClientRect()
      return (
        Math.abs(
          alertRect.left +
            alertRect.width / 2 -
            (stateRect.left + stateRect.width / 2)
        ) < 1 &&
        Math.abs(
          alertRect.top +
            alertRect.height / 2 -
            (stateRect.top + stateRect.height / 2)
        ) < 1
      )
    })
    assert.strictEqual(
      centeredTranscriptError,
      true,
      'a full-page transcript load error must be centered in its content region'
    )
    await transcriptFailurePage.close()

    const memoryFilesFailurePage = await context.newPage()
    await memoryFilesFailurePage.route(
      '**/api/memory/revisions/1/content',
      (route) =>
        route.fulfill({
          status: 422,
          contentType: 'application/json',
          body: '{"error":"invalid_memory_tree_artifact"}'
        })
    )
    await memoryFilesFailurePage.goto(`${base}/memory/revisions/1/tree`, {
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
      '/api/memory/revisions/1/artifact',
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
      await partialFailurePage
        .getByText('Automatic maintenance', { exact: true })
        .waitFor()
      await partialFailurePage.getByText('Revisions', { exact: true }).click()
      await partialFailurePage.locator('.revision-graph-node').first().waitFor()
      await partialFailurePage
        .getByText('Observations', { exact: true })
        .click()
      await partialFailurePage.locator('tbody tr').first().waitFor()
      assert.ok(
        (await partialFailurePage.locator('tbody tr').count()) > 0,
        'an overview failure must not discard successfully loaded observations'
      )
      await partialFailurePage.unroute('**/api/memory/overview*')
      await partialFailurePage.getByText('Revisions', { exact: true }).click()
      const loadedRevisionCount = await partialFailurePage
        .locator('.revision-graph-node')
        .count()
      await partialFailurePage.route('**/api/memory/revisions*', (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: '{"error":"memory_catalog_unavailable"}'
        })
      )
      await partialFailurePage
        .getByRole('button', { name: 'Refresh', exact: true })
        .click()
      await partialFailurePage
        .getByText('Revision history could not be loaded.', { exact: true })
        .waitFor()
      assert.strictEqual(
        await partialFailurePage.locator('.revision-graph-node').count(),
        loadedRevisionCount,
        'a failed revision refresh must preserve the last successful revision history'
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
        .getByText('The current memory revision could not be loaded.', {
          exact: true
        })
        .waitFor()
      await unknownCurrentPage.getByText('Revisions', { exact: true }).click()
      await unknownCurrentPage.locator('.revision-graph-node').first().waitFor()
      assert.strictEqual(
        await unknownCurrentPage
          .locator('.revision-graph-node[data-current]')
          .count(),
        0,
        'unknown current revision must not mark any graph node as current'
      )
      assert.strictEqual(
        await unknownCurrentPage
          .getByRole('button', { name: 'Set current', exact: true })
          .count(),
        0,
        'unknown current revision must not expose set-current in the graph'
      )
      await unknownCurrentPage.getByText('List', { exact: true }).click()
      assert.strictEqual(
        await unknownCurrentPage.locator('tr[aria-current="true"]').count(),
        0,
        'unknown current revision must not mark any list row as current'
      )
      assert.strictEqual(
        await unknownCurrentPage
          .getByRole('button', { name: 'Set current', exact: true })
          .count(),
        0,
        'unknown current revision must not expose set-current in the list'
      )
      assert.strictEqual(
        await unknownCurrentPage
          .getByText('Already current', { exact: true })
          .count(),
        0,
        'unknown current revision must not invent an already-current state'
      )
      await unknownCurrentPage.close()
    }
  }
}

export async function runMemoryFlow({
  name,
  viewport,
  page,
  context,
  browser,
  base,
  server,
  waitUntil
}) {
  if (server !== undefined) {
    const zhContext = await browser.newContext({ viewport, locale: 'zh-CN' })
    const zhPage = await zhContext.newPage()
    await zhPage.addInitScript(() => localStorage.setItem('ui-language', 'zh'))
    await zhPage.goto(`${base}/memory`, { waitUntil: 'domcontentloaded' })
    await zhPage.getByRole('heading', { name: '记忆' }).waitFor()
    const maintenanceSwitch = zhPage.getByRole('switch', {
      name: '自动维护'
    })
    await maintenanceSwitch.waitFor()
    await zhPage.getByRole('img', { name: '说明自动维护控制行为' }).hover()
    const maintenanceHelp = zhPage.getByRole('tooltip')
    await maintenanceHelp.waitFor()
    assert.ok(
      (await maintenanceHelp.textContent())?.trim(),
      `${name} maintenance help tooltip must render its explanation`
    )
    await zhPage.getByText('概览', { exact: true }).waitFor()
    await zhPage
      .getByRole('region', { name: '概览' })
      .getByText('未产出观察项', { exact: true })
      .waitFor()
    await zhPage.getByText('修订历史', { exact: true }).click()
    await zhPage.getByText('列表', { exact: true }).click()
    await zhPage.locator('tr[aria-current="true"]').waitFor()
    await zhPage.getByText('修订历史', { exact: true }).waitFor()
    await zhPage.getByText('观察项', { exact: true }).click()
    const zhIncorporationLayout = await zhPage.evaluate(() => {
      const container = document.querySelector('.memory-incorporation')
      const label = container?.querySelector('span')
      const link = container?.querySelector('button')
      if (!container || !label || !link) return null
      return {
        gap: Number.parseFloat(getComputedStyle(container).columnGap),
        labelSize: getComputedStyle(label).fontSize,
        linkSize: getComputedStyle(link).fontSize
      }
    })
    assert.ok(
      zhIncorporationLayout !== null &&
        zhIncorporationLayout.gap > 0 &&
        zhIncorporationLayout.labelSize === zhIncorporationLayout.linkSize,
      `${name} Chinese incorporated revision text and link must share typography and a real gap: ${JSON.stringify(zhIncorporationLayout)}`
    )
    await zhPage
      .locator('.mantine-Tabs-panel:visible')
      .getByRole('button', { name: '过程' })
      .first()
      .click()
    const zhExtractionDialog = zhPage.getByRole('dialog', {
      name: '提取过程'
    })
    await zhExtractionDialog.waitFor()
    await zhExtractionDialog.locator('.mantine-Modal-close').click()
    await zhPage.getByRole('button', { name: '编辑当前记忆' }).waitFor()
    await zhContext.close()

    const memoryEndpoints = [
      '/api/memory/maintenance-control',
      '/api/memory/tree',
      '/api/memory/revisions',
      '/api/memory/observations',
      '/api/memory/overview'
    ]
    const memoryRequestCounts = Object.fromEntries(
      memoryEndpoints.map((endpoint) => [endpoint, 0])
    )
    const countMemoryRequest = (request) => {
      const pathname = new URL(request.url()).pathname
      const endpoint = memoryEndpoints.find(
        (candidate) =>
          pathname === candidate || pathname.startsWith(`${candidate}/`)
      )
      if (endpoint !== undefined) memoryRequestCounts[endpoint] += 1
    }
    page.on('request', countMemoryRequest)
    await page.getByRole('link', { name: 'Memory' }).click()
    await page.getByRole('heading', { name: 'Memory' }).waitFor()
    assert.strictEqual(
      await page.getByLabel('Go to run ID').count(),
      0,
      `${name} run navigation must not appear on the memory page`
    )
    await page
      .getByRole('button', { name: 'Refresh', exact: true })
      .waitFor({ state: 'visible' })
    await waitUntil(
      async () =>
        !(await page
          .getByRole('button', { name: 'Refresh', exact: true })
          .isDisabled()),
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
    for (const endpoint of memoryEndpoints.slice(0, -1))
      assert.strictEqual(
        memoryRequestCounts[endpoint],
        initialMemoryRequestCounts[endpoint],
        `${name} overview range changes must not request ${endpoint}`
      )
    page.off('request', countMemoryRequest)
    await page.getByText('Revisions', { exact: true }).click()
    const revisionGraphLayout = await page.evaluate(() => {
      const box = (revision) => {
        const node = document.querySelector(
          `.revision-graph-node[aria-label="revision ${revision}"]`
        )
        if (node === null) return null
        const bounds = node.getBoundingClientRect()
        return { x: bounds.x, y: bounds.y }
      }
      return { revision3: box(3), revision2: box(2), revision1: box(1) }
    })
    assert.ok(
      revisionGraphLayout.revision3 !== null &&
        revisionGraphLayout.revision2 !== null &&
        revisionGraphLayout.revision1 !== null &&
        revisionGraphLayout.revision3.y < revisionGraphLayout.revision2.y &&
        revisionGraphLayout.revision2.y < revisionGraphLayout.revision1.y &&
        revisionGraphLayout.revision3.x !== revisionGraphLayout.revision2.x,
      `${name} revision graph must place newer revisions above their shared predecessor and expose the branch: ${JSON.stringify(revisionGraphLayout)}`
    )
    if (viewport.width >= 768) {
      const graphCentering = await page.evaluate(() => {
        const viewport = document.querySelector('.revision-graph-scroll')
        const graph = document.querySelector('.revision-graph')
        if (!viewport || !graph) return null
        const viewportBox = viewport.getBoundingClientRect()
        const graphBox = graph.getBoundingClientRect()
        return {
          viewportCenter: viewportBox.left + viewportBox.width / 2,
          graphCenter: graphBox.left + graphBox.width / 2
        }
      })
      assert.ok(
        graphCentering !== null &&
          Math.abs(graphCentering.viewportCenter - graphCentering.graphCenter) <
            2,
        `${name} a graph narrower than its viewport must start centered: ${JSON.stringify(graphCentering)}`
      )
    }
    assert.strictEqual(
      await page.locator('.revision-graph-node[data-current]').count(),
      1,
      `${name} revision graph must mark exactly one active revision`
    )
    if (name === 'desktop')
      assert.strictEqual(
        await page
          .locator('.revision-graph-node[data-current]')
          .getAttribute('aria-label'),
        'revision 2',
        `${name} initial graph must distinguish the active revision from the newest revision`
      )
    await page.getByText('List', { exact: true }).click()
    await page
      .locator('tr[aria-current="true"]')
      .getByText('Already current', { exact: true })
      .waitFor()
    await page.screenshot({
      path: `/tmp/control-plane-ui-memory-${name}.png`,
      fullPage: true
    })
    const memoryBody = await page.locator('body').boundingBox()
    assert.ok(
      memoryBody !== null && memoryBody.width <= viewport.width + 1,
      `${name} memory layout overflows horizontally`
    )
    const revisionColumnLayout = await page.evaluate(() => {
      const revision = document.querySelector('.memory-revision-cell')
      const predecessor = document.querySelector('.memory-predecessor-cell')
      if (revision === null || predecessor === null) return null
      return {
        revisionWidth: revision.getBoundingClientRect().width,
        predecessorWidth: predecessor.getBoundingClientRect().width,
        revisionAlign: getComputedStyle(revision).textAlign,
        predecessorAlign: getComputedStyle(predecessor).textAlign
      }
    })
    assert.deepStrictEqual(
      revisionColumnLayout,
      {
        revisionWidth: 120,
        predecessorWidth: 120,
        revisionAlign: 'center',
        predecessorAlign: 'center'
      },
      `${name} revision and predecessor columns must share centered numeric layout`
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
              : icon.getBoundingClientRect().left -
                button.getBoundingClientRect().left
        }
      })
    )
    assert.ok(
      currentActionLayout.length >= 2 &&
        currentActionLayout.every(
          (layout) =>
            Math.abs(layout.left - currentActionLayout[0].left) < 2 &&
            layout.width === currentActionLayout[0].width &&
            Math.abs(
              (layout.iconOffset ?? 0) -
                (currentActionLayout[0].iconOffset ?? 0)
            ) < 2
        ),
      `${name} set-current and already-current actions must keep the same geometry: ${JSON.stringify(currentActionLayout)}`
    )
    const revisionTwoRow = page.locator('tbody tr').filter({
      has: page.locator('.memory-revision-cell', { hasText: /^2$/ })
    })
    await revisionTwoRow.getByRole('button', { name: 'Files' }).click()
    const treeDialog = page.getByRole('dialog', {
      name: /Memory files · revision/
    })
    await treeDialog.getByText('Security Review Experience Memory').waitFor()
    const treeSplitter = treeDialog.getByRole('separator', {
      name: 'Resize file tree'
    })
    if (viewport.width >= 768) {
      const splitterBox = await treeSplitter.boundingBox()
      assert.ok(
        splitterBox !== null,
        `${name} file tree splitter must be visible`
      )
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
      await revisionTwoRow.getByRole('button', { name: 'Files' }).click()
      await page
        .getByRole('dialog', { name: /Memory files · revision/ })
        .getByText('Security Review Experience Memory')
        .waitFor()
      const restoredWidth =
        (
          await page
            .getByRole('dialog', { name: /Memory files · revision/ })
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
    await treeDialog
      .getByRole('link', { name: 'Authentication comparisons' })
      .click()
    await treeDialog
      .getByText('Constant-time comparison', { exact: true })
      .waitFor()
    await treeDialog.getByRole('button', { name: 'MEMORY.md' }).click()
    await treeDialog.getByText('Source', { exact: true }).click()
    await treeDialog
      .getByText('# Security Review Experience Memory', { exact: false })
      .waitFor()
    await treeDialog.locator('.mantine-Modal-close').click()

    await revisionTwoRow.getByRole('button', { name: 'Changes' }).click()
    const diffDialog = page.getByRole('dialog', {
      name: /Compare revision 2 with revision 1/
    })
    await diffDialog.locator('.memory-diff-editor .cm-editor').first().waitFor()
    const diffTitleLayout = await diffDialog
      .locator('.memory-diff-title')
      .evaluate((title) => ({
        parts: [...title.children].map((part) => part.textContent),
        gap: Number.parseFloat(getComputedStyle(title).columnGap)
      }))
    assert.deepStrictEqual(
      diffTitleLayout.parts,
      ['Compare', 'revision 2', 'with', 'revision 1'],
      `${name} revision diff title must render semantic parts in language order`
    )
    assert.ok(
      diffTitleLayout.gap > 0,
      `${name} revision diff title spacing must come from layout gap`
    )
    assert.strictEqual(
      await diffDialog.getByText('Preview', { exact: true }).count(),
      0,
      `${name} revision diff must not expose the file preview mode`
    )
    assert.strictEqual(
      await diffDialog.getByText('Source', { exact: true }).count(),
      0,
      `${name} revision diff must not expose the file source mode`
    )
    assert.ok(
      (await diffDialog.locator('.file-workspace-marker').count()) > 0,
      `${name} revision diff must mark changed files`
    )
    assert.strictEqual(
      await diffDialog
        .getByRole('link', { name: 'Open in new page' })
        .getAttribute('href'),
      '/memory/revisions/2/diff',
      `${name} revision diff must expose a stable full-page URL`
    )
    await diffDialog.getByText('Unified', { exact: true }).click()
    await diffDialog.locator('.memory-diff-editor > .cm-editor').waitFor()
    await diffDialog.locator('.mantine-Modal-close').click()
    const diffPage = await context.newPage()
    await diffPage.goto(`${base}/memory/revisions/2/diff`, {
      waitUntil: 'networkidle'
    })
    await diffPage
      .getByRole('heading', { name: 'Compare revision 2 with revision 1' })
      .waitFor()
    await diffPage.locator('.memory-diff-editor .cm-editor').first().waitFor()
    await diffPage.close()

    await page.getByRole('button', { name: 'Process' }).first().click()
    const maintenanceDialog = page.getByRole('dialog', {
      name: 'Maintenance process'
    })
    await maintenanceDialog
      .locator('.transcript-message')
      .getByText('System', { exact: true })
      .waitFor()
    await maintenanceDialog
      .locator('.transcript-message')
      .getByText('AI response', { exact: true })
      .waitFor()
    const transcriptLayout = await maintenanceDialog.evaluate((dialog) => {
      const layout = dialog.querySelector('.transcript-layout')
      const timeline = dialog.querySelector('.transcript-timeline')
      const minimap = dialog.querySelector('.transcript-minimap')
      const body = dialog.querySelector('.mantine-Modal-body')
      if (layout === null || timeline === null || body === null) return null
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
      transcriptLayout !== null &&
        transcriptLayout.layoutWidth >= transcriptLayout.bodyWidth - 48,
      `${name} transcript layout must fill the modal content width`
    )
    assert.ok(
      transcriptLayout !== null &&
        transcriptLayout.timelineWidth >=
          transcriptLayout.layoutWidth -
            transcriptLayout.minimapWidth -
            transcriptLayout.gap -
            1,
      `${name} transcript timeline must fill the column next to the minimap`
    )
    assert.strictEqual(
      transcriptLayout?.minimapPresent,
      viewport.width > 700,
      `${name} transcript minimap must be mounted only when its rail has room`
    )
    await waitUntil(
      () =>
        maintenanceDialog.evaluate((dialog) => {
          const minimap = dialog.querySelector('.transcript-minimap')
          if (minimap === null) return true
          let scroller = minimap.parentElement
          while (
            scroller !== null &&
            !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
          )
            scroller = scroller.parentElement
          if (scroller === null) return false
          const rail = minimap.getBoundingClientRect()
          const port = scroller.getBoundingClientRect()
          return (
            Math.abs(
              rail.top + rail.height / 2 - (port.top + port.height / 2)
            ) < 8
          )
        }),
      `${name} transcript rail must center in the modal scrollport`
    )
    await maintenanceDialog
      .getByPlaceholder('Search messages, tools, and arguments')
      .fill('current memory')
    await waitUntil(
      async () =>
        (await maintenanceDialog.locator('.transcript-message').count()) === 1,
      `${name} transcript search must filter messages`
    )
    assert.strictEqual(
      await maintenanceDialog.locator('mark').textContent(),
      'current memory',
      `${name} transcript search must highlight the matching text`
    )
    const fullTranscriptHref = await maintenanceDialog
      .getByRole('link', { name: 'Open in new page' })
      .getAttribute('href')
    assert.match(
      fullTranscriptHref ?? '',
      /^\/memory\/revisions\/\d+\/transcript$/,
      `${name} transcript modal must expose a dedicated page`
    )
    await maintenanceDialog
      .getByPlaceholder('Search messages, tools, and arguments')
      .fill('')
    await maintenanceDialog.getByRole('button', { name: 'Expand all' }).click()
    await maintenanceDialog
      .getByRole('button', { name: 'Collapse all' })
      .click()
    await maintenanceDialog.locator('.mantine-Modal-close').click()

    assert.strictEqual(
      await page
        .locator('.mantine-Tabs-panel:visible')
        .getByRole('link', { name: /Download (memory tree|transcript)/ })
        .count(),
      0,
      `${name} revision rows must keep downloads inside their viewers`
    )
    await page.getByText('Observations', { exact: true }).click()
    const observationIndex = page
      .locator('tbody .memory-observation-index')
      .first()
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
    const incorporatedRevision = page.getByRole('button', {
      name: 'revision 2'
    })
    await incorporatedRevision.click()
    const linkedRevisionNode = page.locator(
      '.revision-graph-node[data-revision-node="2"]'
    )
    await waitUntil(
      async () =>
        (await page
          .getByRole('tab', { name: 'Revisions' })
          .getAttribute('aria-selected')) === 'true' &&
        (await page.getByRole('radio', { name: 'Graph' }).isChecked()) &&
        (await linkedRevisionNode.evaluate(
          (node) =>
            document.activeElement === node &&
            node.hasAttribute('data-selected') &&
            node.hasAttribute('data-highlighted')
        )),
      `${name} incorporated revision link must reveal and highlight its graph node`
    )
    await page.getByText('Observations', { exact: true }).click()
    assert.strictEqual(
      await page
        .locator('.mantine-Tabs-panel:visible')
        .getByRole('link', { name: 'Download transcript' })
        .count(),
      0,
      `${name} observation rows must not duplicate transcript downloads`
    )
    await page
      .locator('.mantine-Tabs-panel:visible')
      .getByRole('button', { name: 'Process' })
      .first()
      .click()
    const extractionDialog = page.getByRole('dialog', {
      name: 'Extraction process'
    })
    await waitUntil(
      async () =>
        (await extractionDialog.locator('.transcript-message').count()) === 4 &&
        (await extractionDialog.locator('.transcript-tool').count()) === 1,
      `${name} extraction transcript must render all messages and its tool result`
    )
    await extractionDialog.locator('.mantine-Modal-close').click()
    await page.getByText('Revisions', { exact: true }).click()
    await page.getByText('List', { exact: true }).click()
    const currentRevision = (
      (await page
        .locator('tr[aria-current="true"] .memory-revision-cell')
        .textContent()) ?? ''
    ).trim()
    if (currentRevision !== '1') {
      const revisionOneRow = page.locator('tbody tr').filter({
        has: page.locator('.memory-revision-cell', { hasText: /^1$/ })
      })
      await revisionOneRow.getByRole('button', { name: 'Set current' }).click()
      const restoreDialog = page.getByRole('dialog')
      await restoreDialog
        .getByText(/This immediately changes the active memory to revision 1\./)
        .waitFor()
      await restoreDialog
        .getByRole('button', { name: 'Set as current' })
        .click()
    }
    await waitUntil(
      async () =>
        (
          (await page
            .locator('tr[aria-current="true"] .memory-revision-cell')
            .textContent()) ?? ''
        ).trim() === '1',
      `${name} restoring revision 1 must move the active pointer to revision 1`
    )
    const revisionBefore = Number(
      (
        (await page
          .locator('tbody tr:first-child .memory-revision-cell')
          .textContent()) ?? ''
      ).match(/^\d+/)?.[0]
    )
    await page.getByRole('button', { name: 'Edit current memory' }).click()
    const editDialog = page.getByRole('dialog', { name: 'Edit memory files' })
    await editDialog.getByRole('button', { name: 'MEMORY.md' }).waitFor()
    const editorHeight =
      (await editDialog.getByLabel('Workspace editor').boundingBox())?.height ??
      0
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
    assert.strictEqual(
      await editDialog.getByRole('button', { name: 'renamed.md' }).count(),
      0,
      `${name} memory workspace must delete an uncommitted file`
    )
    await editDialog.getByRole('button', { name: 'Cancel' }).click()
    const discardDialog = page.getByRole('dialog', {
      name: 'Discard memory changes?'
    })
    await discardDialog
      .getByText('Your edits have not been committed and will be lost.')
      .waitFor()
    await discardDialog
      .getByRole('button', { name: 'Continue editing' })
      .click()
    await editDialog.getByRole('button', { name: 'Commit revision' }).click()
    await waitUntil(
      async () =>
        (
          (await page
            .locator('tbody tr:first-child .memory-revision-cell')
            .textContent()) ?? ''
        ).startsWith(String(revisionBefore + 1)),
      `${name} committed memory revision must become current`
    )
    assert.strictEqual(
      (
        await page
          .locator('tbody tr:first-child .memory-predecessor-cell')
          .textContent()
      )?.trim(),
      '1',
      `${name} a new revision after restore must retain revision 1 as its predecessor`
    )
  }
}
