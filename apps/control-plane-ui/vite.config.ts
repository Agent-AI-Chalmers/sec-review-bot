import type { UserConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { mockApi } from './mock-api/index.js'

export default function createViteConfig(): UserConfig {
  return {
    plugins: [react(), ...(process.env.CONTROL_PLANE_UI_MOCK_API === '1' ? [mockApi()] : [])],
    build: {
      target: 'es2025',
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              {
                name: 'editor',
                test: /node_modules[\\/](?:@codemirror|codemirror|@lezer|style-mod|w3c-keyname|crelt)[\\/]/,
                maxSize: 250_000,
                priority: 20
              },
              {
                name: 'ui',
                test: /node_modules[\\/](?:@mantine|@floating-ui)[\\/]/,
                maxSize: 400_000,
                priority: 10
              }
            ]
          }
        }
      }
    },
    server: { proxy: { '/api': 'http://127.0.0.1:8091' } }
  }
}
