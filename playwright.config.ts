import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  // Media decode/encode tests are CPU-bound; parallel workers starve each
  // other's probe/encode deadlines and flake.
  workers: 1,
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:5177',
    headless: true,
    viewport: { width: 1600, height: 900 },
    launchOptions: {
      args: ['--autoplay-policy=no-user-gesture-required'],
    },
  },
  webServer: {
    command: 'npm run dev -- --port 5177 --strictPort',
    port: 5177,
    reuseExistingServer: true,
    timeout: 30_000,
  },
})
