import { existsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

// Playwright enables coloured worker output itself. An inherited NO_COLOR makes
// Node warn whenever FORCE_COLOR is added for those workers.
delete process.env.NO_COLOR

const chromeCandidates = [
  process.env.CONTROL_PLANE_UI_CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable'
].filter((candidate): candidate is string => candidate !== undefined)
const executablePath = chromeCandidates.find((candidate) =>
  existsSync(candidate)
)
const externalDeployment = process.env.CONTROL_PLANE_UI_BASE_URL !== undefined
const fixedFixturePort = process.env.CONTROL_PLANE_UI_E2E_PORT !== undefined
const isolatedLocalWorkers = !externalDeployment && !fixedFixturePort

if (executablePath === undefined) {
  throw new Error(
    `Chrome not found. Tried ${chromeCandidates.join(', ')}. Set CONTROL_PLANE_UI_CHROME_PATH.`
  )
}

export default defineConfig({
  testDir: './test/e2e',
  timeout: 120_000,
  fullyParallel: isolatedLocalWorkers,
  // External deployments share data and capacity. A fixed local port also cannot
  // host more than one fixture server, so both modes run predictably in one worker.
  workers: isolatedLocalWorkers ? 3 : 1,
  reporter: [
    ['line'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }]
  ],
  use: {
    locale: 'en-US',
    permissions: ['clipboard-read', 'clipboard-write'],
    launchOptions: { executablePath },
    // CI uploads these only when the browser job fails. Traces retain DOM and
    // network timing for races; screenshots preserve the final rendered state.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'desktop',
      use: { viewport: { width: 1440, height: 900 } }
    },
    {
      name: 'mobile',
      use: { viewport: { width: 390, height: 844 } }
    }
  ]
})
