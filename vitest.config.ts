import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The _verify entry covers the pure maths behind the picture-quality
    // harness (_verify/quality/*.mjs). Those functions are the measuring stick
    // every export-quality change is judged against, so they get unit tested
    // like source, not left to be checked by eye inside a Playwright run.
    include: ['src/**/*.test.ts', '_verify/**/*.test.mjs'],
    environment: 'node',
  },
})
