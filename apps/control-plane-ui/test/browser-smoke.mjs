import { existsSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'

// Two modes:
//   - Self-managed (default): each job starts its own Vite dev server with
//     `CONTROL_PLANE_UI_DEV_FIXTURES=1`, so browser state and fixture mutations
//     cannot leak between jobs.
//   - Attached: set CONTROL_PLANE_UI_BASE_URL (and CONTROL_PLANE_UI_ACCESS_TOKEN
//     for an authenticated BFF) to smoke an already-running deployment. Attached
//     jobs run one at a time because the deployment's state is shared.
//
// Jobs are split by viewport and feature. By default all eight jobs run through a
// small concurrency pool; `SMOKE_SHARD` selects one or more for a CI matrix:
//   SMOKE_SHARD=desktop-memory-preflight
//   SMOKE_SHARD=desktop-memory
//   SMOKE_SHARD=desktop
//   SMOKE_SHARD=memory-preflight
// `SMOKE_CONCURRENCY` overrides the pool size (default 3).
const EXTERNAL_BASE = process.env.CONTROL_PLANE_UI_BASE_URL
const TOKEN = process.env.CONTROL_PLANE_UI_ACCESS_TOKEN
const SHARD = process.env.SMOKE_SHARD ?? 'all'

// GitHub's ubuntu runner images preinstall Chrome; the apt package installs
// `google-chrome-stable` with a `google-chrome` symlink.
const CHROME_CANDIDATES = [
  process.env.CONTROL_PLANE_UI_CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable'
].filter((candidate) => candidate !== undefined)
const CHROME_PATH = CHROME_CANDIDATES.find((candidate) => existsSync(candidate))
if (CHROME_PATH === undefined) {
  throw new Error(
    `Chrome not found. Tried ${CHROME_CANDIDATES.join(', ')}. Set CONTROL_PLANE_UI_CHROME_PATH.`
  )
}

/** Relative luminance contrast, so the theme can be checked without pixel baselines. */
const CONTRAST = `(() => {
  const parse = (value) => {
    const match = value.match(/rgba?\\(([^)]+)\\)/)
    if (!match) return null
    const parts = match[1].split(',').map((part) => Number.parseFloat(part))
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
  }
  const luminance = ({ r, g, b }) => {
    const channel = (c) => {
      const s = c / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  }
  const background = (element) => {
    let node = element
    while (node) {
      const colour = parse(getComputedStyle(node).backgroundColor)
      if (colour && colour.a > 0.9) return colour
      node = node.parentElement
    }
    return { r: 255, g: 255, b: 255, a: 1 }
  }
  const ratio = (selector) => {
    const element = document.querySelector(selector)
    if (!element) return null
    const foreground = parse(getComputedStyle(element).color)
    if (!foreground) return null
    const a = luminance(foreground)
    const b = luminance(background(element))
    return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100
  }
  return {
    background: background(document.body),
    title: ratio('h1'),
    cell: ratio('tbody td span')
  }
})()`

const EXPECTED_HEADERS = [
  'Run',
  'Workflow',
  'Platform',
  'Preparation',
  'Execution',
  'Publication',
  'Last activity',
  'Failure code'
]

const { smokeMemoryPreflight, smokeMemory } =
  await import('./browser-smoke/memory.mjs')
const { smokeRuns } = await import('./browser-smoke/runs.mjs')
const { smokeViewer } = await import('./browser-smoke/viewer.mjs')

async function waitForServer(url) {
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline)
      throw new Error(`dev server at ${url} never became ready.`)
    await delay(250)
  }
}

async function waitUntil(
  predicate,
  message,
  { timeoutMs = 5_000, intervalMs = 50 } = {}
) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(message)
    await delay(intervalMs)
  }
}

async function waitUntilValue(
  produce,
  predicate,
  message,
  { timeoutMs = 5_000, intervalMs = 50 } = {}
) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await produce()
    if (predicate(value)) return value
    if (Date.now() > deadline) throw new Error(message)
    await delay(intervalMs)
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const socket = createNetServer()
    socket.once('error', reject)
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address()
      const port =
        typeof address === 'object' && address !== null ? address.port : 0
      socket.close(() => resolve(port))
    })
  })
}

async function startFixtureServer() {
  if (EXTERNAL_BASE !== undefined)
    return { base: EXTERNAL_BASE, server: undefined }
  process.env.CONTROL_PLANE_UI_DEV_FIXTURES = '1'
  const { createServer } = await import('vite')
  const port = await freePort()
  const server = await createServer({
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      // The smoke suite deliberately injects a 401 to verify the sign-in fallback.
      // Forwarding browser console errors makes that expected React boundary noisy.
      forwardConsole: false
    }
  })
  await server.listen()
  const base = `http://127.0.0.1:${port}`
  await waitForServer(`${base}/`)
  return { base, server }
}

async function runFilesError(page, base) {
  await page.goto(`${base}/runs/fixture-artifact-load-error/files`, {
    waitUntil: 'domcontentloaded'
  })
  await page
    .getByText('The run files could not be opened.', { exact: true })
    .waitFor()
  await page.getByRole('link', { name: 'Download diagnostic bundle' }).waitFor()
}

async function runJob({ name, viewport, module }) {
  const { base, server } = await startFixtureServer()
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true
  })
  try {
    const context = await browser.newContext({
      viewport,
      locale: 'en-US',
      permissions: ['clipboard-read', 'clipboard-write']
    })
    const page = await context.newPage()
    await page.goto(`${base}/runs`, { waitUntil: 'networkidle' })
    if (TOKEN !== undefined) {
      await page.getByLabel('Access token').fill(TOKEN)
      await page.getByRole('button', { name: 'Sign in' }).click()
      await page.waitForURL('**/runs')
    }
    await page.getByRole('heading', { name: 'Runs' }).waitFor()

    if (module === 'memory-preflight') {
      await smokeMemoryPreflight({ name, context, base, server })
    } else if (module === 'memory') {
      await smokeMemory({
        name,
        viewport,
        page,
        context,
        browser,
        base,
        server,
        waitUntil
      })
    } else if (module === 'runs') {
      const hasRuns = await smokeRuns({
        name,
        viewport,
        page,
        browser,
        base,
        server,
        waitUntil,
        waitUntilValue,
        contrastScript: CONTRAST,
        expectedHeaders: EXPECTED_HEADERS
      })
      if (hasRuns) await runFilesError(page, base)
    } else {
      await smokeViewer({ page })
    }
    console.log(`browser-smoke ${name}-${module}: ok (${base})`)
  } finally {
    await browser.close()
    if (server !== undefined) await server.close()
  }
}

const VIEWPORTS = [
  ['desktop', { width: 1440, height: 900 }],
  ['mobile', { width: 390, height: 844 }]
]
const MODULES = ['memory-preflight', 'memory', 'runs', 'viewer']

function selectJobs() {
  const jobs = []
  for (const [name, viewport] of VIEWPORTS)
    for (const module of MODULES) jobs.push({ name, viewport, module })
  if (SHARD === 'all') return jobs
  const [first, ...rest] = SHARD.split('-')
  if (first === 'desktop' || first === 'mobile') {
    const module = rest.join('-')
    return jobs.filter(
      (job) => job.name === first && (module === '' || job.module === module)
    )
  }
  return jobs.filter((job) => job.module === SHARD)
}

const jobs = selectJobs()
if (jobs.length === 0) throw new Error(`Unknown SMOKE_SHARD: ${SHARD}`)
const concurrency = Math.max(
  1,
  Number(process.env.SMOKE_CONCURRENCY ?? (EXTERNAL_BASE === undefined ? 3 : 1))
)
const failures = []
let cursor = 0
await Promise.all(
  Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    for (;;) {
      const job = jobs[cursor]
      cursor += 1
      if (job === undefined) return
      try {
        await runJob(job)
      } catch (error) {
        failures.push(error)
      }
    }
  })
)
if (failures.length > 0) {
  if (failures.length === 1) throw failures[0]
  throw new AggregateError(failures, `${failures.length} smoke jobs failed`)
}
