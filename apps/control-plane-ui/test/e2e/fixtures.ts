import { expect, test as base, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'

interface FixtureRuntime {
  baseURL: string
  server: ViteDevServer | undefined
}

interface WorkerFixtures {
  fixtureRuntime: FixtureRuntime
}

function fixturePort(): number {
  const configuredPort = process.env.CONTROL_PLANE_UI_E2E_PORT
  if (configuredPort === undefined) return 0

  const port = Number(configuredPort)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `CONTROL_PLANE_UI_E2E_PORT must be an integer from 1 to 65535; received ${configuredPort}.`
    )
  }
  return port
}

export const test = base.extend<object, WorkerFixtures>({
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

      process.env.CONTROL_PLANE_UI_DEV_FIXTURES = '1'
      let server: ViteDevServer | undefined
      try {
        server = await createServer({
          server: {
            host: '127.0.0.1',
            port: fixturePort(),
            strictPort: true,
            forwardConsole: false
          }
        })
        await server.listen()
        const resolvedURL = server.resolvedUrls?.local[0]
        if (resolvedURL === undefined)
          throw new Error('Vite did not report its fixture server URL.')
        const baseURL = resolvedURL.replace(/\/$/, '')
        await use({ baseURL, server })
      } finally {
        await server?.close()
      }
    },
    { scope: 'worker' }
  ],
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
