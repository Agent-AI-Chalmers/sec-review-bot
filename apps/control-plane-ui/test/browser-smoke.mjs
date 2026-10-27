import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'

// Two modes:
//   - Self-managed (default): starts the Vite dev server with `CONTROL_PLANE_UI_DEV_FIXTURES=1`
//     and asserts the run-console invariants against the deterministic fixtures. No
//     database, BFF, or access token required, so CI can run it unattended.
//   - Attached: set CONTROL_PLANE_UI_BASE_URL (and CONTROL_PLANE_UI_ACCESS_TOKEN for an
//     authenticated BFF) to smoke an already-running deployment instead.
const FIXTURE_PORT = 5188
const EXTERNAL_BASE = process.env.CONTROL_PLANE_UI_BASE_URL
const TOKEN = process.env.CONTROL_PLANE_UI_ACCESS_TOKEN

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

// Bind loopback explicitly. Vite's default host is `localhost`, which Node may
// resolve to ::1 first, leaving 127.0.0.1 refused.
let server
let base = EXTERNAL_BASE
if (base === undefined) {
  process.env.CONTROL_PLANE_UI_DEV_FIXTURES = '1'
  const { createServer } = await import('vite')
  server = await createServer({
    server: {
      host: '127.0.0.1',
      port: FIXTURE_PORT,
      strictPort: true,
      // The smoke suite deliberately injects a 401 to verify the sign-in fallback.
      // Forwarding browser console errors makes that expected React boundary noisy.
      forwardConsole: false
    }
  })
  await server.listen()
  base = `http://127.0.0.1:${FIXTURE_PORT}`
  await waitForServer(`${base}/`)
}

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

// Poll a predicate until it is true, instead of sleeping a fixed amount and
// hoping the UI has settled. The predicate runs immediately and then every
// interval, so a condition that is already true costs nothing.
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

// Like waitUntil, but for a producer whose current value is wanted back: poll
// until the predicate accepts the value, then return it.
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

const { smokeMemoryPreflight, smokeMemory } =
  await import('./browser-smoke/memory.mjs')
const { smokeRuns } = await import('./browser-smoke/runs.mjs')
const { smokeViewer } = await import('./browser-smoke/viewer.mjs')

const browser = await chromium.launch({
  executablePath: CHROME_PATH,
  headless: true
})
try {
  for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844 }]
  ]) {
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

    await smokeMemoryPreflight({ name, context, base, server })
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
    if (hasRuns) {
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
      await smokeViewer({ page })
      console.log(`browser-smoke ${name}: ok (${base})`)
    }
    await context.close()
  }
} finally {
  await browser.close()
  if (server !== undefined) await server.close()
}
