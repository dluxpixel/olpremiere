import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist',
      'out',
      'release',
      'vendor',
      'node_modules',
      'playwright-report',
      'test-results',
      '_verify',
      'eslint.config.js',
      // Helper worktrees live here, each a whole copy of the repo with its own
      // build. They are not this tree's code: linting them failed a ship.
      '.claude',
      // The desktop build writes its config out as electron.vite.config.<time>.mjs
      // and deletes it again. In the release gate it runs beside lint, and on
      // 2026-10-27 lint listed that file and then failed to open it (ENOENT).
      'electron.vite.config.*.mjs',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    // The ship scripts ship everything else, and a typo in a branch that only
    // runs on a bad night (the push retry) used to surface only on that night.
    // `no-undef` is the check that catches that class.
    files: ['scripts/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    // These two also hand functions to a browser page (page.evaluate), which
    // run with the page's globals, not node's.
    files: ['scripts/cold-start.mjs', 'scripts/make-app-icon.mjs'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
)
