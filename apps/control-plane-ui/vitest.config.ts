import react from '@vitejs/plugin-react'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: [
      'react',
      'react-dom/client',
      '@mantine/core',
      '@mantine/hooks',
      '@tabler/icons-react',
      '@testing-library/react',
      'react-markdown',
      'remark-gfm',
      'mdast-util-from-markdown'
    ]
  },
  test: {
    attachmentsDir: 'test-results/components',
    // Isolate concurrent package runs (vitest-dev/vitest#11748).
    fsModuleCachePath: `${import.meta.dirname}/node_modules/.vitest-cache`,
    // Bound concurrent Node workers and browser component files on shared CI runners.
    maxWorkers: 3,
    projects: [
      {
        extends: true,
        test: {
          name: 'types',
          include: [],
          typecheck: {
            enabled: true,
            only: true,
            tsconfig: 'tsconfig.server.json',
            include: ['test/**/*.test-d.ts']
          }
        }
      },
      {
        extends: true,
        test: {
          name: 'logic',
          environment: 'node',
          include: ['test/*.test.ts']
        }
      },
      {
        extends: true,
        test: {
          name: 'components',
          testTimeout: 5_000,
          browser: {
            enabled: true,
            headless: true,
            screenshotDirectory: 'test-results/components/screenshots',
            trace: { mode: 'retain-on-failure', tracesDir: 'test-results/components/traces' },
            provider: playwright({
              launchOptions: {
                channel: 'chrome',
                ...(process.env.CONTROL_PLANE_UI_CHROME_PATH
                  ? { executablePath: process.env.CONTROL_PLANE_UI_CHROME_PATH }
                  : {})
              }
            }),
            instances: [{ browser: 'chromium' }]
          },
          include: ['test/components/**/*.test.tsx'],
          setupFiles: ['./test/components/setup.ts']
        }
      }
    ]
  }
})
