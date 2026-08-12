// Shared release helpers.
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Where a ship writes everything it saw. ONE rolling file, overwritten each run,
 * because his C drive is the thing that fills up and a folder of build logs is
 * the last thing it needs.
 */
export const SHIP_LOG = 'C:/Users/skyle/AppData/Local/olp-build/last-ship.log'

/**
 * Open the ship log. Returns a writer that also survives being called when the
 * file cannot be opened, because a logging problem must never be the thing that
 * stops a release.
 */
export function openShipLog(header) {
  try {
    mkdirSync(dirname(SHIP_LOG), { recursive: true })
    const s = createWriteStream(SHIP_LOG)
    s.write(`${header}\n`)
    return s
  } catch {
    return null
  }
}

/**
 * Run a command, show it live, AND keep every byte of it in the ship log.
 *
 * ⛔ WHY THIS EXISTS. On 2026-08-12 a release failed after a 25 minute gate had
 * already gone green, and **nobody could say why**: the command had been piped
 * through `tail`, so all that survived was the last few lines, which were the
 * error object and not the error. The rebuild worked and the cause is still
 * unknown. `stdio: 'inherit'` means the child writes past this script straight
 * to whatever the terminal happens to be, so the script itself never sees the
 * one thing worth keeping.
 *
 * The fix is NOT "remember not to pipe it". The log is written here, so it
 * exists however the command was invoked, and a failure prints where to read it.
 */
export function runLogged(cmd, label, log) {
  return new Promise((resolve, reject) => {
    const banner = `\n▶ ${label}\n`
    process.stdout.write(banner)
    log?.write(banner)
    const child = spawn(cmd, { shell: true, stdio: ['inherit', 'pipe', 'pipe'] })
    child.stdout.on('data', (d) => {
      process.stdout.write(d)
      log?.write(d)
    })
    child.stderr.on('data', (d) => {
      process.stderr.write(d)
      log?.write(d)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${label} exited ${code}`))
    })
  })
}

/**
 * The GitHub token, from $GH_TOKEN or a gitignored `.env.release` (GH_TOKEN=...).
 * Storing it locally means shipping never needs a token pasted in again. null if none.
 */
export function loadToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim()
  try {
    if (existsSync('.env.release')) {
      const m = readFileSync('.env.release', 'utf8').match(/^\s*GH_TOKEN\s*=\s*(.+?)\s*$/m)
      if (m) return m[1].replace(/^["']|["']$/g, '').trim()
    }
  } catch {
    // ignore
  }
  return null
}

/** fetch with retries, because node/undici is flaky in this env (ENOTFOUND / ECONNABORTED). */
export async function fetchRetry(url, opts = {}, tries = 4) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, opts)
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 800 * (i + 1)))
    }
  }
  throw lastErr
}
