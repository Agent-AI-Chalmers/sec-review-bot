import { expect, test as base, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import createViteConfig from '../../vite.config.js'

const MOCK_API_NOW = '2026-11-12T12:00:00Z'

interface FixtureRuntime {
  baseURL: string
  server: ViteDevServer | undefined
}

interface TestFixtures {
  fixtureRuntime: FixtureRuntime
}

function fixturePort(): number {
  const configuredPort = process.env.CONTROL_PLANE_UI_E2E_PORT
  if (configuredPort === undefined) {
    return 0
  }

  const port = Number(configuredPort)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `CONTROL_PLANE_UI_E2E_PORT must be an integer from 1 to 65535; received ${configuredPort}.`
    )
  }
  return port
}

export const test = base.extend<TestFixtures>({
  // Mutating browser flows must not leak versions or session state into later tests.
  fixtureRuntime: [
    async ({ browserName }, use): Promise<void> => {
      if (browserName !== 'chromium') {
        throw new Error('Control Plane UI E2E supports Chromium projects only.')
      }

      const externalBaseURL = process.env.CONTROL_PLANE_UI_BASE_URL
      if (externalBaseURL !== undefined) {
        await use({ baseURL: externalBaseURL, server: undefined })
        return
      }

      const previousEnabled = process.env.CONTROL_PLANE_UI_MOCK_API
      const previousNow = process.env.CONTROL_PLANE_UI_MOCK_API_NOW
      process.env.CONTROL_PLANE_UI_MOCK_API = '1'
      process.env.CONTROL_PLANE_UI_MOCK_API_NOW = MOCK_API_NOW
      let server: ViteDevServer | undefined
      try {
        const config = createViteConfig()
        server = await createServer({
          ...config,
          // Configuration is imported once; each server gets fresh plugins, records, and mutable state.
          configFile: false,
          server: {
            ...config.server,
            host: '127.0.0.1',
            port: fixturePort(),
            strictPort: true,
            forwardConsole: false
          }
        })
        await server.listen()
        const resolvedURL = server.resolvedUrls?.local[0]
        if (resolvedURL === undefined) {
          throw new Error('Vite did not report its fixture server URL.')
        }
        const baseURL = resolvedURL.replace(/\/$/, '')
        await use({ baseURL, server })
      } finally {
        try {
          await server?.close()
        } finally {
          if (previousEnabled === undefined) {
            delete process.env.CONTROL_PLANE_UI_MOCK_API
          } else {
            process.env.CONTROL_PLANE_UI_MOCK_API = previousEnabled
          }
          if (previousNow === undefined) {
            delete process.env.CONTROL_PLANE_UI_MOCK_API_NOW
          } else {
            process.env.CONTROL_PLANE_UI_MOCK_API_NOW = previousNow
          }
        }
      }
    },
    { scope: 'test' }
  ],
  page: async ({ page, fixtureRuntime }, use): Promise<void> => {
    // Playwright's clock also virtualizes RAF. Keep native frame scheduling so
    // CSS height transitions can start and finish on real browser frames.
    if (fixtureRuntime.server !== undefined) {
      await page.context().addInitScript((time: number) => {
        const NativeDate = Date
        const now = () => time
        globalThis.Date = new Proxy(NativeDate, {
          apply: () => new NativeDate(time).toString(),
          construct: (target, args: unknown[], newTarget): Date =>
            Reflect.construct(target, args.length === 0 ? [time] : args, newTarget) as Date,
          get: (target, property, receiver): unknown =>
            property === 'now' ? now : Reflect.get(target, property, receiver)
        })
        // Instance constructors must use the same fixed clock as the global binding.
        Object.defineProperty(NativeDate.prototype, 'constructor', { value: globalThis.Date })
      }, Date.parse(MOCK_API_NOW))
    }
    await use(page)
  },
  baseURL: async ({ fixtureRuntime }, use): Promise<void> => {
    await use(fixtureRuntime.baseURL)
  }
})

export async function openAuthenticatedRuns(page: Page): Promise<void> {
  await page.goto('/runs', { waitUntil: 'networkidle' })

  const accessToken = page.getByLabel('Access token')
  if (await accessToken.isVisible()) {
    const token = process.env.CONTROL_PLANE_UI_ACCESS_TOKEN
    if (token === undefined) {
      throw new Error(
        'The external deployment requires sign-in. Set CONTROL_PLANE_UI_ACCESS_TOKEN for this E2E run.'
      )
    }
    await accessToken.fill(token)
    await page.getByRole('button', { name: 'Sign in' }).click()
  }

  await page.getByRole('heading', { name: 'Runs' }).waitFor()
}

export { expect }

export async function openRunFilters(page: Page): Promise<void> {
  await page.getByRole('heading', { name: 'Runs', exact: true }).waitFor()
  const toggle = page.getByRole('button', { name: /^Filters(?: \(\d+\))?$/ })
  if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) === 'false') {
    await toggle.click()
  }
}
