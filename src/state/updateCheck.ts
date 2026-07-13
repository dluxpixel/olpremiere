// Stale-tab detection. A deployed tab keeps running its old JS forever — old
// bugs included — until a HARD refresh, which nobody knows to do. This watches
// the served index.html for a different app bundle hash and offers a one-click
// reload. Silent in dev (no hashed bundle) and on any fetch hiccup.

import { useToasts } from './toasts'

const CHECK_MS = 5 * 60_000
let notified = false

/** The hashed app bundle path this tab booted with (e.g. /assets/index-Abc123.js). */
function currentBundle(): string | null {
  const script = document.querySelector<HTMLScriptElement>('script[src*="/assets/index-"]')
  return script ? new URL(script.src, window.location.href).pathname : null
}

function servedBundleOf(html: string): string | null {
  const m = /src="(\/assets\/index-[^"]+\.js)"/.exec(html)
  return m ? m[1] : null
}

async function check(booted: string): Promise<void> {
  if (notified) return
  try {
    const r = await fetch('/', { cache: 'no-store' })
    if (!r.ok) return
    const served = servedBundleOf(await r.text())
    if (served && served !== booted) {
      notified = true
      useToasts.getState().show('A new version of OL Studio is live', 'info', {
        label: 'Reload',
        onClick: () => window.location.reload(),
      })
    }
  } catch {
    // offline / transient — try again next tick
  }
}

/** Start watching for a newer deploy: on tab focus and every few minutes. */
export function initUpdateCheck(): void {
  const booted = currentBundle()
  if (!booted) return // dev server — nothing to compare
  const run = (): void => void check(booted)
  window.addEventListener('focus', run)
  window.setInterval(run, CHECK_MS)
  window.setTimeout(run, 15_000) // one early check after boot settles
}
