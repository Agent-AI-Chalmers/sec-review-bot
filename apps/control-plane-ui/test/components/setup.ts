import '../../browser/styles.css'
import '@mantine/core/styles.css'
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { userEvent } from 'vitest/browser'

afterEach((): void => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  document.documentElement.removeAttribute('lang')
})

beforeEach(async () => {
  localStorage.clear()
  // Browser files share origin storage; every test chooses a known initial locale.
  await userEvent.hover(document.body)
  localStorage.setItem('ui-language', 'en')
})
