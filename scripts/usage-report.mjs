// Reads OL Premiere's private usage log and says what he uses, what he does not,
// and where it hurts. His question, 2026-10-04: *"After 1 week or more of usage, we
// can see what doesn't get used and could be cut off from the app, and more. What
// can we improve? What should we focus on, because I use it the most, right?"*
//
//   node scripts/usage-report.mjs                       the real log folder
//   node scripts/usage-report.mjs D:/copy/Usage-log     a COPY of that folder
//   node scripts/usage-report.mjs a.jsonl b.jsonl       single files (the web "Save a copy")
//   --days 7        only the last 7 days of use (counted back from the newest event)
//   --project ab12  only one project (the first letters of its id are enough)
//   --top 30        longer lists
//   --json          the same numbers as JSON, for another tool
//   --src DIR       where the app source is, for the "never used" list (default: this repo)
//
// It only READS. It takes no lock, writes nothing, and a file that is still being
// appended to (a half written last line, a bad line anywhere) costs that line and
// nothing else, so it is safe to run on the live folder and just as good on a copy.
//
// The format is described at the top of src/state/usageLog.ts. In short, one JSON
// object per line: t (when), s (which launch), p (project id), k (kind), a (name),
// d (a few details), ms (how long, for things that last).
//
// Everything printed is plain ASCII, so it reads the same in any terminal.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** A pause longer than this is him away, not him working, and is not counted as time. */
export const IDLE_CAP_MS = 30_000
/** Two actions closer than this belong to one path. */
const PATH_GAP_MS = 15_000
/** The same thing done again within this is a run. */
const RUN_GAP_MS = 10_000
const RUN_MIN = 5
/** An undo this soon after the edit was a miss, not a change of mind. */
const UNDO_FAST_S = 5
/** An edit that lands this soon after a key or a click is that key's effect, not a step of its own. */
const EFFECT_MS = 120
const RARE_AT_MOST = 2

const NOT_ACTIONS = new Set(['session', 'toast', 'error'])
const JOB_KINDS = new Set(['export', 'caption'])
const TIMED_KINDS = new Set(['play', 'dialog', 'record'])

// --- Reading ------------------------------------------------------------------------

/** The folder the desktop app writes to, by platform. */
export function defaultLogFolder() {
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'OL Premiere', 'Usage log')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'OL Premiere', 'Usage log')
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'OL Premiere', 'Usage log')
}

function filesIn(path) {
  const s = statSync(path)
  if (s.isFile()) return [path]
  return readdirSync(path)
    .filter((n) => /\.jsonl$/i.test(n))
    .sort()
    .map((n) => join(path, n))
}

/** One line, or null when it is not an event. A half written last line is simply skipped. */
export function parseLine(line) {
  const text = line.trim()
  if (!text) return null
  try {
    const e = JSON.parse(text)
    if (e && typeof e.t === 'number' && typeof e.k === 'string' && typeof e.a === 'string') return e
  } catch {
    // A line cut off by a crash or caught mid write.
  }
  return undefined
}

/** Every event under the given folders and files, oldest first. */
export function readUsage(paths) {
  const events = []
  const files = []
  let bad = 0
  for (const path of paths) {
    for (const file of filesIn(path)) {
      files.push(file)
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const e = parseLine(line)
        if (e === null) continue
        if (e === undefined) bad += 1
        else events.push(e)
      }
    }
  }
  events.sort((a, b) => a.t - b.t)
  return { events, files, bad }
}

// --- Small helpers --------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0')

/** `2026-10-04` on this machine's clock, the same day the app's file was named for. */
export function dayOf(t) {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export function median(xs) {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function fmtDur(ms) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${pad2(s % 60)}s`
  const h = Math.floor(m / 60)
  return `${h}h ${pad2(m % 60)}m`
}

const pct = (n, total) => (total > 0 ? `${((100 * n) / total).toFixed(1)}%` : '0%')

/** The grouping key: the same thing done twice is one line. */
export function keyOf(e) {
  return `${e.k} ${e.a}`
}

/** What a line of the report calls it. A shortcut says what it is for. */
function labelOf(e) {
  if (e.k === 'key') return `key ${e.a}${e.d?.cmd ? `  (${e.d.cmd})` : ''}`
  if (e.k === 'ui' && e.d?.panel) return `ui ${e.a}  [${e.d.panel}]`
  return keyOf(e)
}

/** True for what HE did: not a toast, an error, a session marker, or the end of a dialog or project. */
export function isAction(e) {
  if (NOT_ACTIONS.has(e.k)) return false
  if (e.k === 'dialog' && e.d?.op === 'close') return false
  if (e.k === 'project' && e.a === 'close') return false
  return true
}

const shortId = (p) => (p ? String(p).slice(0, 8) : '(no project)')

function topEntries(map, n) {
  return [...map].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n)
}

// --- The catalog: what the app OFFERS, read off its own source ---------------------------

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const s = statSync(p)
    if (s.isDirectory()) {
      if (name !== 'node_modules') walk(p, out)
    } else out.push(p)
  }
  return out
}

/** The text of an opening tag, from its `<` to its closing `>`, so its attributes can be read. */
function openingTag(text, from) {
  let depth = 0
  let quote = ''
  for (let i = from + 1; i < Math.min(text.length, from + 4000); i++) {
    const c = text[i]
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = ''
    } else if (c === '"' || c === "'" || c === '`') quote = c
    else if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0 && text[i - 1] !== '=') return text.slice(from, i + 1)
  }
  return text.slice(from, from + 600)
}

const INTERACTIVE_TAGS = new Set(['button', 'Button', 'IconButton', 'select', 'input', 'a', 'summary', 'label'])
const INTERACTIVE_ATTRS = /\bon(Click|Change|PointerDown|KeyDown)=|role="(button|tab|menuitem|switch|checkbox|radio)"/

/**
 * What the app offers, from its source: shortcuts (App.tsx), controls (a data-testid
 * on something that can be pressed) and edits (the labels the Undo toast shows).
 * A control with a dynamic testid is a FAMILY (`move-tile-*`), used if any of it was.
 */
export function scanCatalog(srcDir) {
  const shortcuts = new Map()
  const controls = new Map()
  const families = new Map()
  const labels = new Map()
  const edits = new Set()
  for (const file of walk(srcDir)) {
    // The splash and the update window are their own pages: the log is not running in them.
    if (!/\.(ts|tsx)$/.test(file) || /\.test\.|\.d\.ts$|Fixtures|Fixture\./.test(file) || /[\\/]splash[\\/]/.test(file)) continue
    const text = readFileSync(file, 'utf8')
    const where = basename(file).replace(/\.(ts|tsx)$/, '')
    if (basename(file) === 'App.tsx') {
      for (const m of text.matchAll(/combo:\s*'((?:[^'\\]|\\.)+)'\s*,\s*description:\s*'([^']+)'/g)) {
        // The source spells a backslash key as '\\': what the keymap sees is one backslash.
        const combo = m[1].replace(/\\(.)/g, '$1')
        if (!shortcuts.has(combo)) shortcuts.set(combo, m[2])
      }
    }
    for (const m of text.matchAll(/data-testid=(?:"([^"]+)"|\{`([^`]*)`\})/g)) {
      const lt = text.lastIndexOf('<', m.index)
      if (lt < 0) continue
      const tag = /^<\s*([A-Za-z][\w.]*)/.exec(text.slice(lt, lt + 60))?.[1]
      const attrs = openingTag(text, lt)
      if (!(tag && INTERACTIVE_TAGS.has(tag)) && !INTERACTIVE_ATTRS.test(attrs)) continue
      if (m[1] !== undefined) {
        if (!controls.has(m[1])) controls.set(m[1], where)
      } else {
        const head = m[2].split('${')[0]
        if (head.length >= 3 && !families.has(head)) families.set(head, where)
      }
    }
    // An icon button named only by its label is named by it in the log (a testid wins when there is one).
    for (const m of text.matchAll(/<IconButton\b/g)) {
      const attrs = openingTag(text, m.index)
      const label = /\blabel="([^"]+)"/.exec(attrs)?.[1]
      if (label && !attrs.includes('data-testid')) labels.set(label, where)
    }
    for (const m of text.matchAll(/(?:dispatch|updateActiveSequence)\(\s*'([^'\n]+)'/g)) edits.add(m[1])
  }
  return { shortcuts, controls, families, labels, edits }
}

// --- The report -------------------------------------------------------------------------

/**
 * Everything the report says, as plain data. `catalog` is optional: without it the
 * "never used" part is skipped, because "never" is only meaningful against a list.
 */
export function buildReport(allEvents, opts = {}) {
  const top = opts.top ?? 25
  let events = allEvents
  if (opts.days) {
    const newest = events.at(-1)?.t ?? 0
    const from = newest - opts.days * 86_400_000
    events = events.filter((e) => e.t > from)
  }
  if (opts.project) events = events.filter((e) => e.p && e.p.startsWith(opts.project))

  const report = { events: events.length, empty: events.length === 0 }
  if (events.length === 0) return report

  // --- Sessions, and the time between actions, which is the only honest "time spent".
  const sessions = new Map()
  for (const e of events) {
    let s = sessions.get(e.s)
    if (!s) sessions.set(e.s, (s = { id: e.s, first: e.t, last: e.t, events: [], endMs: 0 }))
    s.last = e.t
    s.events.push(e)
    if (e.k === 'session' && e.a === 'end' && e.ms) s.endMs = e.ms
  }

  const countByKey = new Map()
  const labelByKey = new Map()
  const timeByKey = new Map()
  const countByKind = new Map()
  const days = new Map()
  const projects = new Map()
  const dayOfEvent = (e) => {
    const day = dayOf(e.t)
    let d = days.get(day)
    if (!d) days.set(day, (d = { day, events: 0, sessions: new Set(), attentionMs: 0, counts: new Map() }))
    return d
  }
  const projectOfEvent = (e) => {
    const id = e.p ?? ''
    let p = projects.get(id)
    if (!p) projects.set(id, (p = { id, events: 0, attentionMs: 0, days: new Set(), exports: 0, counts: new Map() }))
    return p
  }

  let attentionMs = 0
  const gapsAfter = new Map()
  for (const s of sessions.values()) {
    const list = s.events
    for (let i = 0; i < list.length; i++) {
      const e = list[i]
      const next = list[i + 1]
      const key = keyOf(e)
      const day = dayOfEvent(e)
      const proj = projectOfEvent(e)
      day.sessions.add(s.id)
      proj.days.add(day.day)
      let charge = 0
      if (isAction(e)) {
        countByKey.set(key, (countByKey.get(key) ?? 0) + 1)
        if (!labelByKey.has(key)) labelByKey.set(key, labelOf(e))
        countByKind.set(e.k, (countByKind.get(e.k) ?? 0) + 1)
        day.events += 1
        proj.events += 1
        day.counts.set(key, (day.counts.get(key) ?? 0) + 1)
        proj.counts.set(key, (proj.counts.get(key) ?? 0) + 1)
        if (e.k === 'export') proj.exports += 1
        // A measured span (a play, a recording) is that long; a point is charged the
        // pause that followed it, up to the idle cap.
        if (TIMED_KINDS.has(e.k) && typeof e.ms === 'number') charge = e.ms
        else if (!JOB_KINDS.has(e.k) && e.k !== 'project' && next) {
          const gap = next.t - e.t
          charge = Math.min(gap, IDLE_CAP_MS)
          if (gap < IDLE_CAP_MS && e.k !== 'dialog') {
            const g = gapsAfter.get(key)
            if (g) g.push(gap)
            else gapsAfter.set(key, [gap])
          }
        }
      } else if (e.k === 'dialog' && typeof e.ms === 'number') {
        // The close of a dialog carries how long it was open: that is time IN it.
        const k = `dialog ${e.a}`
        timeByKey.set(k, (timeByKey.get(k) ?? 0) + e.ms)
      }
      if (charge > 0 && e.k !== 'dialog') {
        timeByKey.set(key, (timeByKey.get(key) ?? 0) + charge)
        attentionMs += charge
        day.attentionMs += charge
        proj.attentionMs += charge
      }
    }
  }

  const totalActions = [...countByKey.values()].reduce((a, b) => a + b, 0)
  const openMs = [...sessions.values()].reduce((a, s) => a + (s.endMs || s.last - s.first), 0)

  const range = [dayOf(events[0].t), dayOf(events.at(-1).t)]
  report.overview = {
    from: range[0],
    to: range[1],
    daysWithUse: days.size,
    events: events.length,
    actions: totalActions,
    sessions: sessions.size,
    appOpenMs: openMs,
    attentionMs,
  }

  report.byCount = topEntries(countByKey, top).map(([key, n]) => ({
    name: labelByKey.get(key),
    kind: key.split(' ', 1)[0],
    count: n,
    share: n / totalActions,
  }))
  report.byTime = topEntries(timeByKey, top).map(([key, ms]) => ({
    name: labelByKey.get(key) ?? key,
    ms,
    count: countByKey.get(key) ?? 0,
  }))
  report.byKind = topEntries(countByKind, 20).map(([kind, n]) => ({ kind, count: n, share: n / totalActions }))

  // --- Shortcuts, and how much of what he does is the keyboard.
  const keyCounts = new Map()
  const keyCmd = new Map()
  let held = 0
  for (const e of events) {
    if (e.k !== 'key') continue
    keyCounts.set(e.a, (keyCounts.get(e.a) ?? 0) + 1)
    if (e.d?.cmd) keyCmd.set(e.a, e.d.cmd)
    held += typeof e.d?.rep === 'number' ? e.d.rep : 0
  }
  const uiCount = countByKind.get('ui') ?? 0
  const keyTotal = [...keyCounts.values()].reduce((a, b) => a + b, 0)
  report.shortcuts = {
    total: keyTotal,
    heldRepeats: held,
    clicks: uiCount,
    top: topEntries(keyCounts, top).map(([combo, n]) => ({ combo, command: keyCmd.get(combo) ?? '', count: n })),
  }

  // --- What the app offers and he never touched.
  if (opts.catalog) {
    const usedUi = new Map()
    const usedEdits = new Map()
    for (const e of events) {
      if (e.k === 'ui') usedUi.set(e.a, (usedUi.get(e.a) ?? 0) + 1)
      if (e.k === 'edit' || e.k === 'import') usedEdits.set(e.a, (usedEdits.get(e.a) ?? 0) + 1)
    }
    const countFamily = (prefix) => [...usedUi].reduce((n, [name, c]) => (name.startsWith(prefix) ? n + c : n), 0)
    const items = []
    for (const [combo, command] of opts.catalog.shortcuts) {
      items.push({ type: 'shortcut', name: `${combo}  (${command})`, count: keyCounts.get(combo) ?? 0 })
    }
    for (const [id, where] of opts.catalog.controls) items.push({ type: 'control', name: `${id}  [${where}]`, count: usedUi.get(id) ?? 0 })
    for (const [prefix, where] of opts.catalog.families) items.push({ type: 'control', name: `${prefix}*  [${where}]`, count: countFamily(prefix) })
    // Icon buttons with no testid are named by their label, with numbers folded the way the log folds them.
    const digitsAsHash = (s) => s.replace(/\d+(?:[.,]\d+)*/g, '#')
    const usedByLabel = new Map()
    for (const [name, c] of usedUi) usedByLabel.set(digitsAsHash(name), (usedByLabel.get(digitsAsHash(name)) ?? 0) + c)
    for (const [label, where] of opts.catalog.labels ?? []) {
      items.push({ type: 'control', name: `"${label}"  [${where}]`, count: usedByLabel.get(digitsAsHash(label)) ?? 0 })
    }
    for (const label of opts.catalog.edits) items.push({ type: 'edit', name: label, count: usedEdits.get(label) ?? 0 })
    const group = (type, test) => items.filter((i) => i.type === type && test(i.count)).sort((a, b) => a.count - b.count || a.name.localeCompare(b.name))
    report.unused = {
      offered: items.length,
      never: {
        shortcuts: group('shortcut', (c) => c === 0).map((i) => i.name),
        controls: group('control', (c) => c === 0).map((i) => i.name),
        edits: group('edit', (c) => c === 0).map((i) => i.name),
      },
      rare: {
        shortcuts: group('shortcut', (c) => c > 0 && c <= RARE_AT_MOST).map((i) => `${i.name}  x${i.count}`),
        controls: group('control', (c) => c > 0 && c <= RARE_AT_MOST).map((i) => `${i.name}  x${i.count}`),
        edits: group('edit', (c) => c > 0 && c <= RARE_AT_MOST).map((i) => `${i.name}  x${i.count}`),
      },
    }
  }

  // --- Paths: what follows what, inside one stretch of work.
  const grams = [new Map(), new Map()]
  const pathKinds = new Set(['key', 'ui', 'edit', 'import', 'history', 'dialog'])
  for (const s of sessions.values()) {
    const items = []
    let lastInput = -Infinity
    for (const e of s.events) {
      if (!pathKinds.has(e.k) || (e.k === 'dialog' && e.d?.op === 'close')) continue
      const input = e.k === 'key' || e.k === 'ui'
      // An edit a hair after a key or click is that key's effect, not another step.
      if (!input && e.t - lastInput <= EFFECT_MS) continue
      if (input) lastInput = e.t
      const label = e.k === 'key' ? `key ${e.a}` : keyOf(e)
      const prev = items.at(-1)
      if (prev && prev.label === label && e.t - prev.t <= RUN_GAP_MS) {
        prev.t = e.t
        continue
      }
      items.push({ label, t: e.t })
    }
    let chain = []
    const flushChain = () => {
      for (let n = 2; n <= 3; n++) {
        for (let i = 0; i + n <= chain.length; i++) {
          const g = chain.slice(i, i + n).join('  >  ')
          grams[n - 2].set(g, (grams[n - 2].get(g) ?? 0) + 1)
        }
      }
      chain = []
    }
    for (let i = 0; i < items.length; i++) {
      if (i > 0 && items[i].t - items[i - 1].t > PATH_GAP_MS) flushChain()
      chain.push(items[i].label)
    }
    flushChain()
  }
  const commonPaths = (map) => topEntries(new Map([...map].filter(([, n]) => n >= 3)), top).map(([path, n]) => ({ path, count: n }))
  report.paths = { pairs: commonPaths(grams[0]), triples: commonPaths(grams[1]) }

  // --- Friction.
  const editTotals = new Map()
  for (const e of events) if (e.k === 'edit' || e.k === 'import') editTotals.set(e.a, (editTotals.get(e.a) ?? 0) + 1)

  // Undone right away: the age the app measured when it can, else the edit just before.
  const undone = new Map()
  const retried = new Map()
  for (const s of sessions.values()) {
    let lastEdit = null
    let afterUndo = null
    for (const e of s.events) {
      if (e.k === 'edit' || e.k === 'import') {
        if (afterUndo && afterUndo.name === e.a && e.t - afterUndo.t <= 15_000) retried.set(e.a, (retried.get(e.a) ?? 0) + 1)
        afterUndo = null
        lastEdit = e
      } else if (e.k === 'history' && e.a === 'undo') {
        const of = e.d?.of
        const fast = typeof e.d?.age === 'number' ? e.d.age <= UNDO_FAST_S : lastEdit && e.t - lastEdit.t <= UNDO_FAST_S * 1000
        if (of && fast) {
          undone.set(of, (undone.get(of) ?? 0) + 1)
          afterUndo = { name: of, t: e.t }
        }
      }
    }
  }
  report.friction = {
    undoneFast: topEntries(undone, top).map(([name, n]) => ({ name, undone: n, made: editTotals.get(name) ?? 0 })),
    triedAgain: topEntries(retried, top).map(([name, n]) => ({ name, times: n })),
  }

  // The same thing again and again: a run of RUN_MIN or more, each within RUN_GAP of the last.
  const runs = new Map()
  for (const s of sessions.values()) {
    let key = null
    let n = 0
    const close = () => {
      if (key && n >= RUN_MIN) {
        const r = runs.get(key) ?? { runs: 0, longest: 0, total: 0 }
        r.runs += 1
        r.longest = Math.max(r.longest, n)
        r.total += n
        runs.set(key, r)
      }
      key = null
      n = 0
    }
    let lastT = 0
    for (const e of s.events) {
      if (!isAction(e) || e.k === 'zoom' || e.k === 'play' || e.k === 'project') continue
      const k = e.k === 'key' ? `key ${e.a}` : keyOf(e)
      const weight = 1 + (typeof e.d?.rep === 'number' ? e.d.rep : 0)
      if (k === key && e.t - lastT <= RUN_GAP_MS) n += weight
      else {
        close()
        key = k
        n = weight
      }
      lastT = e.t
    }
    close()
  }
  report.friction.repeated = [...runs]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, top)
    .map(([name, r]) => ({ name, ...r }))

  // Errors and what he was shown.
  const errors = new Map()
  const errorDays = new Map()
  for (const e of events) {
    if (e.k !== 'error') continue
    errors.set(e.a, (errors.get(e.a) ?? 0) + 1)
    errorDays.set(dayOf(e.t), (errorDays.get(dayOf(e.t)) ?? 0) + 1)
  }
  report.friction.errors = topEntries(errors, top).map(([message, n]) => ({ message, count: n }))
  report.friction.errorDays = [...errorDays].sort((a, b) => a[0].localeCompare(b[0])).map(([day, n]) => ({ day, count: n }))

  // Where he waits: the actions that are usually followed by the longest pause.
  report.friction.slowSteps = [...gapsAfter]
    .filter(([, gaps]) => gaps.length >= 5)
    .map(([key, gaps]) => ({ name: labelByKey.get(key), count: gaps.length, medianMs: median(gaps) }))
    .sort((a, b) => b.medianMs - a.medianMs)
    .slice(0, 8)

  // Jobs: exports and caption runs, which are slow because the machine is.
  const exportsDone = events.filter((e) => e.k === 'export')
  const outcomes = new Map()
  const formats = new Map()
  for (const e of exportsDone) {
    outcomes.set(e.d?.outcome ?? '?', (outcomes.get(e.d?.outcome ?? '?') ?? 0) + 1)
    const f = `${e.d?.w}x${e.d?.h} @${e.d?.fps}${e.d?.loud === false ? ' no-loudness' : ''}`
    formats.set(f, (formats.get(f) ?? 0) + 1)
  }
  const doneMs = exportsDone.filter((e) => e.d?.outcome === 'done' && e.ms).map((e) => e.ms)
  const ratios = exportsDone.filter((e) => e.d?.outcome === 'done' && e.ms && e.d?.sec).map((e) => e.ms / 1000 / e.d.sec)
  const runsT = events.filter((e) => e.k === 'caption').map((e) => e.ms ?? 0)
  report.jobs = {
    exports: {
      count: exportsDone.length,
      outcomes: Object.fromEntries(outcomes),
      medianMs: median(doneMs),
      maxMs: Math.max(0, ...doneMs),
      secondsToMakeOneSecond: median(ratios),
      formats: topEntries(formats, 5).map(([format, n]) => ({ format, count: n })),
    },
    captions: { count: runsT.length, medianMs: median(runsT), maxMs: Math.max(0, ...runsT) },
  }

  report.byDay = [...days.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((d) => ({
      day: d.day,
      events: d.events,
      sessions: d.sessions.size,
      attentionMs: d.attentionMs,
      top: topEntries(d.counts, 3).map(([key, n]) => `${labelByKey.get(key)} x${n}`),
    }))
  report.byProject = [...projects.values()]
    // Boot lines and the like have no project: not a project to list when nothing was done in it.
    .filter((p) => p.events > 0 || p.id !== '')
    .sort((a, b) => b.events - a.events)
    .map((p) => ({
      project: shortId(p.id),
      events: p.events,
      attentionMs: p.attentionMs,
      days: p.days.size,
      exports: p.exports,
      top: topEntries(p.counts, 3).map(([key, n]) => `${labelByKey.get(key)} x${n}`),
    }))
  return report
}

// --- Printing -------------------------------------------------------------------------------

const BAR = 24

function bar(share) {
  return '#'.repeat(Math.max(share > 0 ? 1 : 0, Math.round(share * BAR)))
}

function table(rows) {
  if (rows.length === 0) return ['  (nothing)']
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)))
  return rows.map((r) => '  ' + r.map((cell, c) => (typeof cell === 'number' ? String(cell).padStart(widths[c]) : String(cell).padEnd(widths[c]))).join('  ').trimEnd())
}

/** Short items run together and wrapped, so a long list reads as a paragraph and not a page. */
function wrapList(items, indent = '    ', width = 100) {
  if (items.length === 0) return [`${indent}(none)`]
  const out = []
  let line = indent
  for (const item of items) {
    const piece = `${item}; `
    if (line.length + piece.length > width && line.trim() !== '') {
      out.push(line.trimEnd())
      line = indent
    }
    line += piece
  }
  out.push(line.trimEnd().replace(/;$/, ''))
  return out
}

/** `name  [Component]` items, gathered under their component so a screen's controls sit together. */
function byComponent(items) {
  const groups = new Map()
  for (const item of items) {
    const m = /^(.*?)\s+\[([^\]]+)\](.*)$/.exec(item)
    const key = m ? m[2] : '(named by label)'
    const name = m ? `${m[1]}${m[3]}` : item
    const g = groups.get(key)
    if (g) g.push(name)
    else groups.set(key, [name])
  }
  const out = []
  for (const [component, names] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const lines = wrapList(names, '      ')
    out.push(`    ${component}:`, ...lines)
  }
  return out.length ? out : ['    (none)']
}

export function formatReport(r, ctx = {}) {
  const out = []
  const h = (title) => out.push('', title.toUpperCase(), '-'.repeat(title.length))
  out.push('OL PREMIERE USAGE REPORT')
  if (ctx.sources) out.push(`read: ${ctx.sources}`)
  if (ctx.bad) out.push(`(${ctx.bad} unreadable line${ctx.bad === 1 ? '' : 's'} skipped)`)
  if (r.empty) {
    out.push('', 'No events found. The log fills as the app is used; check the folder and the filters.')
    return out.join('\n') + '\n'
  }
  const o = r.overview
  h('Overview')
  out.push(
    `  ${o.from} to ${o.to}   ${o.daysWithUse} day${o.daysWithUse === 1 ? '' : 's'} with use   ${o.sessions} launch${o.sessions === 1 ? '' : 'es'}`,
    `  ${o.actions} actions (${o.events} lines)   app open ${fmtDur(o.appOpenMs)}   attention ${fmtDur(o.attentionMs)}`,
    '  attention = time between one action and the next, a pause over 30s counts as away',
  )

  h('What he does, by kind')
  out.push(...table(r.byKind.map((k) => [k.kind, k.count, pct(k.count, o.actions), bar(k.share)])))
  out.push('  an edit made with a key or a click is listed twice, as the press and as the edit it made,')
  out.push('  so read the kinds as different views of the same work, not as slices of one pie')

  h('Most used actions, by count')
  out.push(...table(r.byCount.map((a, i) => [i + 1, a.count, pct(a.count, o.actions), a.name])))

  h('Most used actions, by time')
  out.push(...table(r.byTime.map((a, i) => [i + 1, fmtDur(a.ms), a.count, a.name])))
  out.push('  time = how long a play, dialog or recording lasted, or the pause after a one off action')

  h('Shortcuts')
  out.push(`  ${r.shortcuts.total} key presses, ${r.shortcuts.clicks} clicks on buttons and menus (${pct(r.shortcuts.total, r.shortcuts.total + r.shortcuts.clicks)} keyboard)`)
  out.push(...table(r.shortcuts.top.map((s) => [s.combo, s.count, s.command])))

  if (r.unused) {
    const u = r.unused
    h('Never used')
    out.push(`  of ${u.offered} things the app offers, read from its source`)
    out.push('  a control counts as used when it was clicked, pressed on, focused or changed; things that are only')
    out.push('  scrolled, hovered or dragged by a handle with no name show up here too, so read it as a short list to check')
    out.push(`  shortcuts (${u.never.shortcuts.length}):`, ...wrapList(u.never.shortcuts))
    out.push(`  controls (${u.never.controls.length}):`, ...byComponent(u.never.controls))
    out.push(`  edits (${u.never.edits.length}):`, ...wrapList(u.never.edits))
    h(`Used only ${RARE_AT_MOST} times or less`)
    out.push(`  shortcuts (${u.rare.shortcuts.length}):`, ...wrapList(u.rare.shortcuts))
    out.push(`  controls (${u.rare.controls.length}):`, ...byComponent(u.rare.controls))
    out.push(`  edits (${u.rare.edits.length}):`, ...wrapList(u.rare.edits))
  } else {
    h('Never used')
    out.push('  skipped: the app source was not found, so there is no list of what it offers (use --src)')
  }

  h('Most used paths')
  out.push('  two in a row, at least 3 times:')
  out.push(...table(r.paths.pairs.map((p) => [p.count, p.path])))
  out.push('  three in a row:')
  out.push(...table(r.paths.triples.map((p) => [p.count, p.path])))

  const f = r.friction
  h('Friction')
  out.push('  undone within 5 seconds (a miss, not a change of mind):')
  out.push(...table(f.undoneFast.map((x) => [x.undone, `of ${x.made}`, x.name])))
  out.push('  undone, then done again within 15 seconds (tried twice):')
  out.push(...table(f.triedAgain.map((x) => [x.times, x.name])))
  out.push(`  the same thing ${RUN_MIN} or more times in a row (runs, longest, total):`)
  out.push(...table(f.repeated.map((x) => [x.runs, x.longest, x.total, x.name])))
  out.push('  where he pauses longest after:')
  out.push(...table(f.slowSteps.map((x) => [fmtDur(x.medianMs), `x${x.count}`, x.name])))
  out.push('  errors and warnings shown:')
  out.push(...table(f.errors.map((x) => [x.count, x.message])))
  if (f.errorDays.length > 0) out.push('  per day: ' + f.errorDays.map((d) => `${d.day} ${d.count}`).join(', '))

  h('Exports and caption runs')
  const ex = r.jobs.exports
  out.push(`  exports: ${ex.count}   ${Object.entries(ex.outcomes).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`)
  if (ex.count > 0) {
    out.push(`  finished ones took ${fmtDur(ex.medianMs)} typically, ${fmtDur(ex.maxMs)} at most` + (ex.secondsToMakeOneSecond ? ` (about ${ex.secondsToMakeOneSecond.toFixed(1)}s to make each 1s of video)` : ''))
    out.push(...table(ex.formats.map((x) => [x.count, x.format])))
  }
  out.push(`  caption runs: ${r.jobs.captions.count}` + (r.jobs.captions.count ? `   ${fmtDur(r.jobs.captions.medianMs)} typically, ${fmtDur(r.jobs.captions.maxMs)} at most` : ''))

  h('By day')
  out.push(...table(r.byDay.map((d) => [d.day, d.events, `${d.sessions} launch${d.sessions === 1 ? '' : 'es'}`, fmtDur(d.attentionMs), d.top.join(', ')])))

  h('By project (the first 8 characters of its id, which is also in the project file name)')
  out.push(...table(r.byProject.map((p) => [p.project, p.events, fmtDur(p.attentionMs), `${p.days} day${p.days === 1 ? '' : 's'}`, `${p.exports} export${p.exports === 1 ? '' : 's'}`, p.top.join(', ')])))
  return out.join('\n') + '\n'
}

// --- Command line -----------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = { paths: [], top: 25, json: false, catalog: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--days') opts.days = Number(argv[++i])
    else if (a === '--project') opts.project = argv[++i]
    else if (a === '--top') opts.top = Number(argv[++i])
    else if (a === '--src') opts.src = argv[++i]
    else if (a === '--no-catalog') opts.catalog = false
    else if (a === '--help' || a === '-h') opts.help = true
    else opts.paths.push(a)
  }
  return opts
}

const HELP = `usage: node scripts/usage-report.mjs [folder-or-file ...] [--days N] [--project ID] [--top N] [--json] [--src DIR] [--no-catalog]
With no path it reads the desktop app's own log folder. It only reads, so a copy of the folder works the same.`

export function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  const opts = parseArgs(argv)
  if (opts.help) {
    io.out(HELP + '\n')
    return 0
  }
  const paths = opts.paths.length > 0 ? opts.paths.map((p) => resolve(p)) : [defaultLogFolder()]
  for (const p of paths) {
    if (!existsSync(p)) {
      io.err(`Nothing at ${p}\nPass the folder (or a copy of it) as the first argument.\n`)
      return 1
    }
  }
  const { events, files, bad } = readUsage(paths)
  let catalog
  const src = opts.src ? resolve(opts.src) : join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
  if (opts.catalog && existsSync(src)) catalog = scanCatalog(src)
  const report = buildReport(events, { ...opts, catalog })
  if (opts.json) io.out(JSON.stringify({ files: files.length, unreadableLines: bad, report }, null, 2) + '\n')
  else io.out(formatReport(report, { sources: `${files.length} file${files.length === 1 ? '' : 's'} from ${paths.join(', ')}`, bad }))
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2))
