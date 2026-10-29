import type { Locator, Page } from '@playwright/test'

import { expect, openAuthenticatedRuns, test } from './fixtures.js'

async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.keyboard.press('Tab')
    if (
      await target.evaluate((element) => element === document.activeElement)
    ) {
      return
    }
  }
  throw new Error('Target was not reached through keyboard navigation')
}

async function expectVisibleKeyboardFocus(target: Locator): Promise<void> {
  await expect(target).toBeFocused()
  const focus = await target.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      focusVisible: element.matches(':focus-visible'),
      hasIndicator:
        (style.outlineStyle !== 'none' && style.outlineWidth !== '0px') ||
        style.boxShadow !== 'none'
    }
  })
  expect(focus).toEqual({ focusVisible: true, hasIndicator: true })
}

test.beforeEach(async ({ fixtureRuntime }) => {
  test.skip(
    fixtureRuntime.server === undefined,
    'Interaction state checks require the stable local fixture data.'
  )
})

test('primary links and commands expose visible keyboard focus', async ({
  page
}) => {
  await openAuthenticatedRuns(page)

  const runsLink = page.getByRole('link', { name: 'Runs', exact: true })
  await tabTo(page, runsLink)
  await expectVisibleKeyboardFocus(runsLink)

  const jump = page.getByRole('button', { name: 'Jump to run' })
  await tabTo(page, jump)
  await expectVisibleKeyboardFocus(jump)
})

test('disabled and loading button states match their behavior', async ({
  page
}) => {
  await openAuthenticatedRuns(page)
  await expect(
    page.getByRole('button', { name: 'Previous page' })
  ).toBeDisabled()

  let releaseRequest: (() => void) | undefined
  const requestGate = new Promise<void>((resolve) => {
    releaseRequest = resolve
  })
  await page.route('**/api/runs?**', async (route) => {
    await requestGate
    await route.continue()
  })

  const refresh = page.getByRole('button', { name: 'Refresh', exact: true })
  await refresh.click()
  await expect(refresh).toBeDisabled()
  await expect(refresh.locator('.mantine-Loader-root')).toBeVisible()

  releaseRequest?.()
  await expect(refresh).toBeEnabled()
  await expect(refresh.locator('.mantine-Loader-root')).toHaveCount(0)
})
