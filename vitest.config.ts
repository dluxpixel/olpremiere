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
    // ⛔ `.test.tsx` IS THE COMPONENT LAYER AND IT WAS MISSING UNTIL 2026-08-16.
    // Every piece of interface behaviour used to be reachable only through a 20
    // minute Playwright run, which is why the Add effect menu was reverted rather
    // than debugged: four end to end runs, four different failures, and no way to
    // ask "does this popup open" in under a second.
    //
    // A component test says which environment it needs in its own docblock
    // (`@vitest-environment jsdom`), so the several thousand node tests keep
    // running in node and stay fast.
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      '_verify/**/*.test.mjs',
      'scripts/**/*.test.mjs',
      'electron/**/*.test.ts',
    ],
    environment: 'node',
  },
})
