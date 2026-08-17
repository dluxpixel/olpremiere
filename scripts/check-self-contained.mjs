// The installer ships NO node_modules, and this is what makes that safe.
//
// ⛔ WHY THIS EXISTS. Measured 2026-08-17: `app.asar` was 238.9 MB while the whole
// built app, `out/`, was 36.5 MB. The difference was production dependencies that
// the packaged app can never load, riding along in every 242 MB upload:
//
//   - the main process imports node builtins and `electron`, nothing else
//   - the preload is 3.8 KB and does the same
//   - the renderer runs with sandbox: true, contextIsolation: true and
//     nodeIntegration: false, so it CANNOT require a node module even if it tried,
//     and Vite has already bundled every dependency into out/renderer anyway
//
// So `electron-builder.yml` excludes `node_modules/**`. That exclusion is correct
// only while the invariant above holds, and a future native dependency would break
// it silently: the app would install fine and then fail on his machine at the one
// moment it reached for the missing module. **So the invariant is checked here, in
// front of the packaging step, where a failure costs a build instead of a release.**
//
// If this fails, do NOT weaken it. Either bundle the new dependency into out/, or
// add a targeted exception to the files list in electron-builder.yml so that ONE
// module ships and the other two hundred megabytes stay out.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join } from 'node:path'

const ALLOWED = new Set([...builtinModules, 'electron'])
const DIRS = ['out/main', 'out/preload']

/** Every `from "x"`, `require("x")` and `import("x")` specifier in a bundle. */
const SPECIFIER = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g

// ⚠️ The pattern above also matches the word "from" inside ordinary strings, which
// is how the first run of this reported `\r\n\r\n` as a missing module. A real
// module id is a package name, so anything that cannot be one is not one.
const MODULE_ID = /^(?:@[\w.-]+\/)?[\w.-]+(?:\/[\w.-]+)*$/

const jsFiles = (dir) => {
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.js') || name.endsWith('.mjs') || name.endsWith('.cjs')) out.push(p)
    }
  }
  walk(dir)
  return out
}

const offenders = []
for (const dir of DIRS) {
  let files
  try {
    files = jsFiles(dir)
  } catch {
    console.error(`❌ ${dir} is missing. Run npm run build:electron first.`)
    process.exit(2)
  }
  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    for (const [, spec] of src.matchAll(SPECIFIER)) {
      if (spec.startsWith('.') || spec.startsWith('/')) continue // own code
      if (spec.startsWith('node:')) continue
      if (ALLOWED.has(spec)) continue
      if (!MODULE_ID.test(spec)) continue // a string that merely follows the word "from"
      offenders.push(`${file}: ${spec}`)
    }
  }
}

if (offenders.length > 0) {
  console.error('❌ The packaged app reaches outside itself, so excluding node_modules would break it:')
  for (const o of [...new Set(offenders)]) console.error(`   ${o}`)
  console.error('\n   Read the top of scripts/check-self-contained.mjs before changing anything.')
  process.exit(1)
}

console.log('✅ main and preload import only node builtins and electron, so no node_modules need ship.')
