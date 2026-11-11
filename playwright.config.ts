import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the exported web build (`pnpm build:web`).
 * External services (tiles, routing, weather, POIs, AI) are intercepted in
 * tests/e2e/fixtures so the suite is deterministic and works offline in CI.
 */
const PORT = Number(process.env.E2E_PORT ?? 4173);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'off',
    locale: 'cs-CZ',
    timezoneId: 'Europe/Prague',
    geolocation: { latitude: 49.5461, longitude: 18.4475 },
    permissions: ['geolocation'],
  },
  projects: [
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: `node scripts/serve-static.mjs apps/mobile/dist ${PORT}`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
