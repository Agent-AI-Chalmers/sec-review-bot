import react from '@vitejs/plugin-react'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['test/browser/**/*.test.tsx'],
    attachmentsDir: 'test-results/browser-component',
    browser: {
      enabled: true,
      headless: true,
      screenshotDirectory: 'test-results/browser-component/screenshots',
      provider: playwright({
        launchOptions: {
          channel: 'chrome',
          ...(process.env.CONTROL_PLANE_UI_CHROME_PATH
            ? { executablePath: process.env.CONTROL_PLANE_UI_CHROME_PATH }
            : {})
        }
      }),
      instances: [{ browser: 'chromium' }]
    }
  }
})
