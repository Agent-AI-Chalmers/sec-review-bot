import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { devFixtures } from './scripts/dev-fixtures/index.js'

export default defineConfig({
  plugins: [
    react(),
    ...(process.env.CONTROL_PLANE_UI_DEV_FIXTURES === '1'
      ? [devFixtures()]
      : [])
  ],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'editor',
              test: /node_modules[\\/](?:@codemirror|codemirror|@lezer|style-mod|w3c-keyname|crelt)[\\/]/,
              maxSize: 250_000,
              priority: 20
            }
          ]
        }
      }
    }
  },
  server: { proxy: { '/api': 'http://127.0.0.1:8091' } }
})
