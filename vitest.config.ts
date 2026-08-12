import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The _verify entry covers the pure maths behind the picture-quality
    // harness (_verify/quality/*.mjs). Those functions are the measuring stick
    // every export-quality change is judged against, so they get unit tested
    // like source, not left to be checked by eye inside a Playwright run.
    // `scripts` is in for the same reason: the ship script is what ships
    // everything else, and its retry only ever runs inside a 25 minute release,
    // where "check it by eye" means never.
    // electron/ joined for the same reason as the other two: the proxy sweep
    // DELETES files in his user data folder, and what it leaves alone is the
    // half worth proving. Only files that avoid importing 'electron' itself can
    // be tested here, which is why the sweep lives in its own module.
    include: ['src/**/*.test.ts', '_verify/**/*.test.mjs', 'scripts/**/*.test.mjs', 'electron/**/*.test.ts'],
    environment: 'node',
  },
})
