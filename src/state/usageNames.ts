// How the usage log NAMES things without ever writing down what he typed or what
// his files are called. Pure functions, no store, so every rule here is tested
// on its own (usageNames.test.ts).
//
// The rule is a hierarchy, strictest first:
//   1. a name the APP chose (a testid, a shortcut, an edit's label) is kept;
//   2. a name that came from HIS material (a file, a track, a project, a library
//      item) is replaced by a placeholder: <media>, <track>, <item>, <project>;
//   3. anything that still looks like a quoted name, a path or a file name is
//      masked, and every number is turned into # in messages, so "Imported 3
//      files" and "Imported 5 files" are one line in the report.
//
// ⛔ THE TEST THAT SCANS THE SOURCE IS THE REAL GUARD. Rules 2 and 3 cover the
// templates that exist today; usageNames.test.ts reads every edit label and every
// data-testid in src/ and fails when a NEW one interpolates something of his.
// Writing a name into the log by accident would break the one promise the log makes.

import type { UsageDetails, UsageKind } from './usageLog'
import { extensionOf } from './usageLog'

export interface KnownName {
  name: string
  as: 'media' | 'track' | 'item' | 'project'
}

let knownNames: () => readonly KnownName[] = () => []

/**
 * The names of his own material right now, LONGEST FIRST so a file called "a.mp4"
 * inside "intro a.mp4" cannot leave half of the longer one behind. The shell
 * hands in a cached list; asking for it is a reference check, not a scan.
 */
export function setKnownNames(source: () => readonly KnownName[]): void {
  knownNames = source
  cacheFor = null
}

// The same few labels come round again and again (a drag, a run of typing), and the list of
// his names does not change between them. So the answer for a label is kept until the list
// is a different list, and an edit costs a lookup instead of a scan of every name he has.
let cacheFor: readonly KnownName[] | null = null
const redactCache = new Map<string, string>()
const editCache = new Map<string, EditName>()
const CACHE_MAX = 400

function currentNames(): readonly KnownName[] {
  const list = knownNames()
  if (list !== cacheFor) {
    cacheFor = list
    redactCache.clear()
    editCache.clear()
  }
  return list
}

/**
 * A name this short is only taken as a WHOLE WORD: "V1" must not match inside half
 * the words there are, but a track he called "Mic" must still not get through in
 * "Mic volume".
 */
const SHORT_NAME = 4
const wholeWord = new Map<string, RegExp>()

function wholeWordOf(name: string): RegExp {
  let re = wholeWord.get(name)
  if (!re) {
    re = new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu')
    wholeWord.set(name, re)
    if (wholeWord.size > 500) wholeWord.delete(wholeWord.keys().next().value!)
  }
  return re
}

export function redactKnown(text: string): string {
  const list = currentNames()
  if (list.length === 0) return text
  const known = redactCache.get(text)
  if (known !== undefined) return known
  let out = text
  for (const { name, as } of list) {
    if (name.length < 2 || !out.includes(name)) continue
    out = name.length < SHORT_NAME ? out.replace(wholeWordOf(name), `<${as}>`) : out.split(name).join(`<${as}>`)
  }
  if (redactCache.size < CACHE_MAX) redactCache.set(text, out)
  return out
}

/** Static labels that start with a verb the rules below treat as "verb + a name of his". */
export const NAMED_VERB_LABELS: ReadonlySet<string> = new Set([
  'Add adjustment layer',
  'Add audio track',
  'Add marker',
  'Add title',
  'Add video track',
  'Delete clip',
])

const VERB_WITH_NAME = /^(Add|Delete|Place|Listen to) (.+)$/

const QUOTED = /["“”][^"“”]*["“”]/g

export interface EditName {
  kind: UsageKind
  a: string
  d?: UsageDetails
}

/**
 * An undoable edit's label as the log names it. A label is written for HIM, so
 * some interpolate what he called things ("Add intro.mp4", "Apply \"My style\"");
 * those become "Add <media>" and "Apply caption style". The labels that are plain
 * words pass through untouched, so the report reads the way the Undo toast does.
 */
export function editAction(label: string): EditName {
  currentNames()
  const known = editCache.get(label)
  if (known) return known
  const named = nameEdit(label)
  if (editCache.size < CACHE_MAX) editCache.set(label, named)
  return named
}

function nameEdit(label: string): EditName {
  const s = redactKnown(label)
  let m: RegExpExecArray | null
  if ((m = /^Import (\d+) file\(s\)$/.exec(s))) return { kind: 'import', a: 'Import files', d: { n: Number(m[1]) } }
  if ((m = /^Remove (\d+) unused files?$/.exec(s))) return { kind: 'edit', a: 'Remove unused files', d: { n: Number(m[1]) } }
  if (/^(Sync|Unsync) /.test(s)) return { kind: 'edit', a: s.startsWith('Unsync') ? 'Unsync track' : 'Sync track' }
  if (/^Add .+ from Library$/.test(s)) return { kind: 'edit', a: 'Add <item> from Library' }
  if (/^Apply preset .+ to all clips$/.test(s)) return { kind: 'edit', a: 'Apply preset to all clips' }
  if (/^Apply preset /.test(s)) return { kind: 'edit', a: 'Apply preset' }
  if (/^Apply track setup/.test(s)) return { kind: 'edit', a: 'Apply track setup' }
  if (/^Apply ["“]/.test(s)) return { kind: 'edit', a: 'Apply caption style' }
  if ((m = VERB_WITH_NAME.exec(s)) && !NAMED_VERB_LABELS.has(s) && !m[2]!.startsWith('<')) {
    return { kind: 'edit', a: `${m[1]} <name>` }
  }
  return { kind: 'edit', a: s.replace(QUOTED, '"…"').slice(0, 60) }
}

// --- Messages: toasts and errors ------------------------------------------------

/** Words a file's name sits behind in a sentence: "No sound from X", "Could not open X". */
const BOUNDARY =
  /(?:\b(?:for|of|to|from|in|on|at|with|import|open|read|add|load|find|save|export|play|decode|delete|remove|relink|locate|use|probe|convert|finished|failed)\b|[:"([,;])\s*/gi
// An extension holds a letter, so a version ("3.21") or a price is not taken for a file.
const FILE_TOKEN = /\S*[^\s.]\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{2,5}(?!\w)/g
const WIN_PATH = /\b[A-Za-z]:[\\/][^\s"')]*|\\\\[^\s"')]+/g
const POSIX_PATH = /(?<![\w<>])\/(?:[\w.~-]+\/)+[\w.~-]*/g

/** Everything from the word before a file's name to the end of its extension becomes `<file.ext>`. */
function maskFiles(s: string): string {
  let out = ''
  let last = 0
  for (const m of s.matchAll(FILE_TOKEN)) {
    const at = m.index!
    if (at < last) continue
    const head = s.slice(last, at)
    let cut = 0
    for (const b of head.matchAll(BOUNDARY)) cut = b.index! + b[0].length
    out += head.slice(0, cut) + `<file.${extensionOf(m[0])}>`
    last = at + m[0].length
  }
  return out + s.slice(last)
}

/**
 * A toast or an error with his material taken out: known names, quoted names,
 * paths and file names masked, numbers turned into #. Short, one line.
 */
export function maskMessage(text: string): string {
  let s = redactKnown(text)
  s = s.replace(QUOTED, '"…"')
  s = s.replace(WIN_PATH, '<path>').replace(POSIX_PATH, '<path>')
  s = maskFiles(s)
  // A placeholder keeps its own digits (`<file.mp4>`), everything else becomes #.
  s = s.replace(/<[^>]*>|\d+(?:[.,]\d+)*/g, (t) => (t.startsWith('<') ? t : '#'))
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return s.length > 90 ? `${s.slice(0, 90)}…` : s
}

/** `mp4:2 mov:1` for a batch of imports. Extensions only: the names stay out of it. */
export function extensionSummary(names: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const n of names) {
    const e = extensionOf(n) || '?'
    counts.set(e, (counts.get(e) ?? 0) + 1)
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([e, n]) => `${e}:${n}`)
    .join(' ')
}

// --- Buttons, menus, tabs, panels ---------------------------------------------------

/** What counts as "a thing he pressed". A select reports its change, not its click. */
export const INTERACTIVE =
  'button, a[href], summary, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="option"], input[type="checkbox"], input[type="radio"]'

/** Where his own material is on screen: a button in here never gives its TEXT as a name. */
const USER_CONTENT =
  '[data-usage-private], [data-testid="asset-card"], [data-testid="library-card"], [data-testid="clip"], [data-testid="word"], [data-testid="words-clip"], [data-testid^="track-header-"]'

/** The testid families whose last part is HIS (a track's name, a project or media id). */
const USER_TESTID_FAMILIES = ['track-header-', 'track-sync-', 'locate-', 'projects-tab-'] as const

/** A testid as the log names it: the family stays, his part goes. */
export function testIdName(id: string): string {
  for (const f of USER_TESTID_FAMILIES) if (id.startsWith(f)) return `${f}*`
  return id.replace(/-[0-9a-f]{8,}(?:-[0-9a-f]{4,})*/gi, '-*')
}

const PANELS =
  '[role="dialog"], [role="menu"], [data-testid="topbar"], [data-testid="panel-left"], [data-testid="monitor"], [data-testid="panel-right"], [data-testid="timeline"], [data-testid="phone-shell"], [data-testid="toast"]'

const PANEL_NAMES: Record<string, string> = {
  topbar: 'topbar',
  'panel-left': 'left',
  monitor: 'monitor',
  'panel-right': 'right',
  timeline: 'timeline',
  'phone-shell': 'phone',
  toast: 'toast',
}

/** The dialog's own name: its testid, else its label. */
export function dialogName(el: Element): string {
  const id = el.getAttribute('data-testid')
  if (id) return testIdName(id)
  return maskMessage(el.getAttribute('aria-label') ?? 'dialog')
}

/** Which part of the app a control is in: a dialog by name, a menu, or a panel. */
export function panelOf(el: Element): string {
  const host = el.closest(PANELS)
  if (!host) return 'app'
  const role = host.getAttribute('role')
  if (role === 'dialog') return `dialog:${dialogName(host)}`
  if (role === 'menu') return 'menu'
  return PANEL_NAMES[host.getAttribute('data-testid') ?? ''] ?? 'app'
}

export interface UiName {
  a: string
  role: string
}

/**
 * The stable name of a control. In order: an explicit `data-usage` (an empty one
 * means "never name me"), the testid, the aria-label, then, only for a plain
 * button outside his own material, its visible text.
 */
export function uiName(el: Element): UiName {
  const role = el.getAttribute('role') ?? (el.tagName === 'INPUT' ? ((el as HTMLInputElement).type ?? 'input') : el.tagName.toLowerCase())
  const explicit = el.getAttribute('data-usage')
  if (explicit !== null) return { a: explicit || role, role }
  const testid = el.getAttribute('data-testid')
  if (testid) return { a: testIdName(testid), role }
  const aria = el.getAttribute('aria-label')
  if (aria) return { a: maskMessage(aria), role }
  if (!el.closest(USER_CONTENT)) {
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (text && text.length <= 30) return { a: maskMessage(text), role }
  }
  // Nothing of its own: the nearest thing around it that has a name.
  const around = el.parentElement?.closest('[data-testid]')?.getAttribute('data-testid')
  return { a: around ? `${testIdName(around)}>${role}` : role, role }
}
