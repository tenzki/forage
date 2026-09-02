import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    testTimeout: 15_000,
    setupFiles: ['./apps/desktop/src/test-setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/target/**', 'scripts/**'],
  },
})
