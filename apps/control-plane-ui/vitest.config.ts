import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
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
          environment: 'jsdom',
          include: ['test/components/**/*.test.tsx'],
          setupFiles: ['./test/components/setup.ts']
        }
      }
    ]
  }
})
