import { existsSync, mkdirSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'

/**
 * Cross-platform font smoke. It runs unchanged on Linux, macOS, and Windows in
 * CI and uploads the rendered Runs/Memory screenshots as artifacts.
 */
const OUT = process.env.FONT_AUDIT_OUT ?? 'font-audit'
const CHROME_CANDIDATES = [
  process.env.CONTROL_PLANE_UI_CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  process.env.PROGRAMFILES
    ? path.join(
        process.env.PROGRAMFILES,
        'Google/Chrome/Application/chrome.exe'
      )
    : undefined,
  process.env['PROGRAMFILES(X86)']
    ? path.join(
        process.env['PROGRAMFILES(X86)'],
        'Google/Chrome/Application/chrome.exe'
      )
    : undefined
].filter((candidate) => candidate !== undefined)

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

mkdirSync(OUT, { recursive: true })
process.env.CONTROL_PLANE_UI_DEV_FIXTURES = '1'
const { createServer } = await import('vite')
const port = await freePort()
const server = await createServer({
  server: { host: '127.0.0.1', port, strictPort: true, forwardConsole: false }
})
await server.listen()
const base = `http://127.0.0.1:${port}`
await waitForServer(`${base}/`)

const executablePath = CHROME_CANDIDATES.find((candidate) =>
  existsSync(candidate)
)
const browser = await chromium.launch({
  ...(executablePath === undefined
    ? { channel: 'chrome' }
    : { executablePath }),
  headless: true
})
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    reducedMotion: 'reduce'
  })
  const page = await context.newPage()
  await page.goto(`${base}/runs`, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { level: 1 }).first().waitFor()
  await page.evaluate(() => document.fonts.ready)
  const info = await page.evaluate(() => {
    const body = getComputedStyle(document.body)
    return {
      platform: navigator.platform,
      interLoaded: document.fonts.check('16px "Inter Variable"'),
      fontFaces: [...document.fonts].map((face) => face.family),
      bodyFamily: body.fontFamily,
      bodyNumeric: body.fontVariantNumeric
    }
  })
  console.log(JSON.stringify(info, null, 2))
  if (!info.interLoaded)
    throw new Error('Inter Variable did not load on this platform.')
  if (!info.bodyNumeric.includes('tabular-nums'))
    throw new Error('body does not use tabular-nums on this platform.')
  await page.screenshot({
    path: path.join(OUT, `runs-${process.platform}.png`)
  })
  await page.goto(`${base}/memory`, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { level: 1 }).first().waitFor()
  await page.screenshot({
    path: path.join(OUT, `memory-${process.platform}.png`)
  })
} finally {
  await browser.close()
  await server.close()
}
