import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { devFixtures } from './dev-fixtures.js'

export default defineConfig({
  plugins: [react(), ...(process.env.CONTROL_PLANE_UI_DEV_FIXTURES === '1' ? [devFixtures()] : [])],
  server: { proxy: { '/api': 'http://127.0.0.1:8091' } }
})
