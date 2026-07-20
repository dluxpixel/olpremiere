// The single central keymap. Every shortcut in the app registers here so the
// full map can be audited (and later rendered as a help sheet). "mod" is Ctrl
// on Windows/Linux and Cmd on macOS.

/** Grouping for the command palette and the shortcut cheat sheet. */
export type BindingDomain = 'transport' | 'selection' | 'trim' | 'tools' | 'view' | 'project'

export interface Binding {
  combo: string
  description: string
  domain: BindingDomain
  run: (e: KeyboardEvent) => void
}

export const DOMAIN_ORDER: BindingDomain[] = [
  'transport',
  'selection',
  'trim',
  'tools',
  'view',
  'project',
]

export const DOMAIN_LABELS: Record<BindingDomain, string> = {
  transport: 'Transport',
  selection: 'Selection',
  trim: 'Edit & Trim',
  tools: 'Tools',
  view: 'View',
  project: 'Project',
}

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform)

export function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = []
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('mod')
  if (e.shiftKey) parts.push('shift')
  if (e.altKey) parts.push('alt')
  let key = e.key.toLowerCase()
  if (key === ' ') key = 'space'
  parts.push(key)
  return parts.join('+')
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  )
}

/** Install the keymap on window. Returns an uninstall function. */
export function installKeymap(bindings: Binding[]): () => void {
  const byCombo = new Map(bindings.map((b) => [b.combo, b]))
  const onKeyDown = (e: KeyboardEvent) => {
    if (isEditableTarget(e.target)) return
    const binding = byCombo.get(comboFromEvent(e))
    if (!binding) return
    e.preventDefault()
    binding.run(e)
  }
  window.addEventListener('keydown', onKeyDown)
  return () => window.removeEventListener('keydown', onKeyDown)
}

/**
 * One row per command: aliases (same description, e.g. Redo on mod+shift+z and
 * mod+y, or the three '?' interpretations) collapse to their first combo.
 */
export function dedupeBindings(bindings: Binding[]): Binding[] {
  const seen = new Set<string>()
  return bindings.filter((b) => {
    if (seen.has(b.description)) return false
    seen.add(b.description)
    return true
  })
}

export interface BindingGroup {
  domain: BindingDomain
  label: string
  rows: Binding[]
}

/**
 * Deduped keymap grouped by domain in display order. Both the command palette
 * and KeyboardHelp render from this, so neither can drift from the real map.
 */
export function groupBindings(bindings: Binding[]): BindingGroup[] {
  const rows = dedupeBindings(bindings)
  return DOMAIN_ORDER.map((domain) => ({
    domain,
    label: DOMAIN_LABELS[domain],
    rows: rows.filter((b) => b.domain === domain),
  })).filter((g) => g.rows.length > 0)
}

/**
 * Greedy subsequence fuzzy match. Returns a score (higher is better), or null
 * when the query is not a subsequence of the text. Bonuses for consecutive
 * hits and word-start hits; light penalties for a late first hit and long text
 * so tight matches ("snap" in "Toggle snapping") rank above scattered ones.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (q.length === 0) return 0
  let score = 0
  let from = 0
  let prevHit = -2
  let firstHit = -1
  for (const ch of q) {
    if (ch === ' ') continue
    const idx = t.indexOf(ch, from)
    if (idx === -1) return null
    if (firstHit === -1) firstHit = idx
    score += 1
    // Contiguous runs outrank scattered word-start (acronym) hits, so "snap"
    // puts 'Toggle snapping' above 'Selection and play'.
    if (idx === prevHit + 1) score += 3
    if (idx === 0 || t[idx - 1] === ' ' || t[idx - 1] === '+' || t[idx - 1] === '/') score += 2
    prevHit = idx
    from = idx + 1
  }
  return score - firstHit * 0.1 - t.length * 0.01
}

/**
 * Fuzzy-filter the deduped keymap. Empty query returns every command in keymap
 * order; otherwise results are ranked by score (ties keep keymap order). The
 * haystack includes the shortcut label and domain so "ctrl" or "tools" work.
 */
export function searchBindings(bindings: Binding[], query: string): Binding[] {
  const rows = dedupeBindings(bindings)
  const q = query.trim()
  if (q === '') return rows
  const scored: { b: Binding; i: number; score: number }[] = []
  for (let i = 0; i < rows.length; i++) {
    const b = rows[i]
    const score = fuzzyScore(q, `${b.description} ${comboLabel(b.combo)} ${DOMAIN_LABELS[b.domain]}`)
    if (score !== null) scored.push({ b, i, score })
  }
  scored.sort((a, z) => z.score - a.score || a.i - z.i)
  return scored.map((x) => x.b)
}

/** Human-readable shortcut label for tooltips, e.g. "Ctrl+Shift+Z". */
export function comboLabel(combo: string): string {
  return combo
    .split('+')
    .map((part) => {
      switch (part) {
        case 'mod':
          return isMac ? '⌘' : 'Ctrl'
        case 'shift':
          return 'Shift'
        case 'alt':
          return isMac ? '⌥' : 'Alt'
        case 'space':
          return 'Space'
        default:
          return part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)
      }
    })
    .join('+')
}
