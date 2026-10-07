import { chromium } from 'playwright-core'

const token = process.env.CONTROL_PLANE_UI_ACCESS_TOKEN
if (!token) throw new Error('CONTROL_PLANE_UI_ACCESS_TOKEN is required.')
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
try {
  for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844 }]
  ]) {
    const page = await browser.newPage({ viewport })
    await page.goto('http://127.0.0.1:8091/runs')
    await page.getByLabel('Access token').fill(token)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL('**/runs')
    await page.getByRole('heading', { name: 'Review runs' }).waitFor()
    await page.screenshot({ path: `/tmp/control-plane-ui-${name}.png`, fullPage: true })
    const body = await page.locator('body').boundingBox()
    if (body === null || body.width > viewport.width + 1)
      throw new Error(`${name} layout overflows horizontally.`)
    await page.close()
  }
} finally {
  await browser.close()
}
