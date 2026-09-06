import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

// Vite only exposes VITE_-prefixed variables and never writes to process.env, so the
// root .env is loaded explicitly here. Tests that gate on a service being reachable
// (see TEST_DATABASE_URL in apps/server/src/postgres.test.ts) read it from process.env.
// A variable already set in the shell wins, so CI can override without touching .env.
export default defineConfig(({ mode }) => ({
  test: {
    environment: 'jsdom',
    globals: true,
    testTimeout: 15_000,
    setupFiles: ['./apps/desktop/src/test-setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/target/**', 'scripts/**'],
    env: loadEnv(mode, process.cwd(), ''),
  },
}))
