import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5177',
    headless: true,
    viewport: { width: 1600, height: 900 },
  },
  webServer: {
    command: 'npm run dev -- --port 5177 --strictPort',
    port: 5177,
    reuseExistingServer: true,
    timeout: 30_000,
  },
})
