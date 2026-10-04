// The usage report: that it reads a folder (or a copy of one) without writing to it,
// shrugs off a bad or half written line, and that each number it prints is the one
// the log says. Built on small made up days, so every figure here can be checked by hand.

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildReport, dayOf, formatReport, fmtDur, IDLE_CAP_MS, main, median, parseLine, readUsage, scanCatalog } from './usage-report.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'usage-report.mjs')
const REPO_SRC = join(HERE, '..', 'src')

const DAY1 = new Date(2026, 9, 4, 10, 0, 0).getTime()
const DAY2 = new Date(2026, 9, 5, 14, 0, 0).getTime()

/** Events one after another from `start`, `gap` ms apart, all in one launch of one project. */
function run(start, gap, items, base = {}) {
  let t = start
  return items.map(([k, a, d, ms]) => {
    const e = { t, s: 'sess', p: 'projAAAA-1111', k, a, ...base }
    if (d) e.d = d
    if (ms !== undefined) e.ms = ms
    t += gap
    return e
  })
}

const lines = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n'

function folderWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'olp-report-'))
  for (const [name, events] of Object.entries(files)) writeFileSync(join(dir, name), typeof events === 'string' ? events : lines(events))
  return dir
}

describe('reading the log', () => {
  it('takes a good line, skips junk and a half written one, and says nothing for a blank', () => {
    expect(parseLine('{"t":1,"s":"a","k":"key","a":"c"}')).toMatchObject({ a: 'c' })
    expect(parseLine('')).toBeNull()
    expect(parseLine('   ')).toBeNull()
    expect(parseLine('{"t":1,"s":"a","k":"key","a":')).toBeUndefined()
    expect(parseLine('not json')).toBeUndefined()
    expect(parseLine('{"nothing":"useful"}')).toBeUndefined()
  })

  it('reads every day file in a folder, oldest first, counting the lines it could not read', () => {
    const dir = folderWith({
      'usage-2026-10-05.jsonl': run(DAY2, 1000, [['key', 'x']]),
      'usage-2026-10-04.jsonl': lines(run(DAY1, 1000, [['key', 'a'], ['key', 'b']])) + '{"t":123,"s":"x","k":"key"\n',
      'notes.txt': 'not a log',
    })
    const { events, files, bad } = readUsage([dir])
    expect(events.map((e) => e.a)).toEqual(['a', 'b', 'x'])
    expect(files).toHaveLength(2)
    expect(bad).toBe(1)
  })

  it('reads single files too, as the browser build saves them', () => {
    const dir = folderWith({ 'ol-premiere-usage-2026-10-04.jsonl': run(DAY1, 1000, [['key', 'a']]) })
    expect(readUsage([join(dir, 'ol-premiere-usage-2026-10-04.jsonl')]).events).toHaveLength(1)
  })
})

describe('counts and time', () => {
  const events = [
    ...run(DAY1, 5_000, [
      ['key', 'c', { cmd: 'Split at playhead' }],
      ['edit', 'Split clip'],
      ['key', 'c', { cmd: 'Split at playhead' }],
      ['ui', 'settings-open', { panel: 'topbar', role: 'button' }],
      ['dialog', 'settings-dialog', { op: 'open' }],
      ['dialog', 'settings-dialog', { op: 'close' }, 42_000],
      ['play', 'playback', { sec: 20 }, 20_000],
    ]),
    // A pause of ten minutes: away, charged only up to the idle cap.
    ...run(DAY1 + 600_000, 5_000, [['key', 'c', { cmd: 'Split at playhead' }], ['key', 'v', { cmd: 'Selection tool' }]]),
  ]

  it('counts what he did, not toasts, errors, or the closing of a dialog', () => {
    const r = buildReport([...events, ...run(DAY1 + 700_000, 1000, [['toast', 'Saved'], ['error', 'boom']])])
    const byName = Object.fromEntries(r.byCount.map((x) => [x.name, x.count]))
    expect(byName['key c  (Split at playhead)']).toBe(3)
    expect(byName['edit Split clip']).toBe(1)
    expect(byName['ui settings-open  [topbar]']).toBe(1)
    expect(r.overview.actions).toBe(8)
    expect(r.byKind.find((k) => k.kind === 'toast')).toBeUndefined()
    expect(r.byCount[0].name).toBe('key c  (Split at playhead)')
    expect(r.byCount[0].share).toBeCloseTo(3 / 8)
  })

  it('charges a one off action the pause after it, up to the idle cap', () => {
    const r = buildReport(events)
    const time = Object.fromEntries(r.byTime.map((x) => [x.name, x.ms]))
    // Three presses of C: 5s, 5s, and the one before the ten minute pause, which is capped.
    expect(time['key c  (Split at playhead)']).toBe(5_000 + 5_000 + 5_000)
    // A play and a dialog are as long as they lasted.
    expect(time['play playback']).toBe(20_000)
    expect(time['dialog settings-dialog']).toBe(42_000)
    expect(IDLE_CAP_MS).toBe(30_000)
  })

  it('caps a long pause at the idle cap', () => {
    const r = buildReport(run(DAY1, 600_000, [['key', 'a'], ['key', 'b']]))
    expect(r.byTime.find((x) => x.name === 'key a')?.ms).toBe(IDLE_CAP_MS)
  })

  it('reports the overview: days, launches, and how long the app was open', () => {
    const two = [
      ...run(DAY1, 1000, [['session', 'start'], ['key', 'a'], ['session', 'end', undefined, 3_600_000]], { s: 'one' }),
      ...run(DAY2, 1000, [['session', 'start'], ['key', 'b'], ['session', 'end', undefined, 1_800_000]], { s: 'two' }),
    ]
    const o = buildReport(two).overview
    expect(o).toMatchObject({ daysWithUse: 2, sessions: 2, actions: 2, from: dayOf(DAY1), to: dayOf(DAY2) })
    expect(o.appOpenMs).toBe(5_400_000)
  })

  it('shares keyboard and mouse', () => {
    const r = buildReport(run(DAY1, 1000, [['key', 'c', { cmd: 'Split' }], ['key', 'c', { cmd: 'Split' }], ['ui', 'x'], ['key', 'v', { cmd: 'Select' }]]))
    expect(r.shortcuts).toMatchObject({ total: 3, clicks: 1 })
    expect(r.shortcuts.top[0]).toEqual({ combo: 'c', command: 'Split', count: 2 })
  })
})

describe('what is never used', () => {
  const catalog = {
    shortcuts: new Map([
      ['c', 'Split at playhead'],
      ['f', 'Freeze this frame'],
      ['q', 'Trim head'],
    ]),
    controls: new Map([
      ['settings-open', 'TopBar'],
      ['add-title', 'TimelineToolbar'],
    ]),
    families: new Map([['move-tile-', 'MoveShelf']]),
    labels: new Map([['Zoom in', 'TimelineToolbar']]),
    edits: new Set(['Split clip', 'Freeze frame']),
  }

  it('lists what the app offers that no line mentions, and what was used once or twice', () => {
    const r = buildReport(
      run(DAY1, 1000, [
        ['key', 'c', { cmd: 'Split at playhead' }],
        ['key', 'q', { cmd: 'Trim head' }],
        ['key', 'q', { cmd: 'Trim head' }],
        ['ui', 'settings-open', { panel: 'topbar' }],
        ['ui', 'move-tile-punch', { panel: 'left' }],
        ['ui', 'Zoom in', { panel: 'timeline' }],
        ['edit', 'Split clip'],
      ]),
      { catalog },
    )
    expect(r.unused.offered).toBe(9)
    expect(r.unused.never.shortcuts).toEqual(['f  (Freeze this frame)'])
    expect(r.unused.never.controls).toEqual(['add-title  [TimelineToolbar]'])
    expect(r.unused.never.edits).toEqual(['Freeze frame'])
    expect(r.unused.rare.shortcuts).toEqual(['c  (Split at playhead)  x1', 'q  (Trim head)  x2'])
    expect(r.unused.rare.controls.join('\n')).toMatch(/settings-open.*x1/)
    // A family counts as used when any of it was.
    expect(r.unused.never.controls.join('\n')).not.toMatch(/move-tile/)
    expect(r.unused.never.controls.join('\n')).not.toMatch(/Zoom in/)
  })

  it('says it skipped the list when it has none to compare against', () => {
    const r = buildReport(run(DAY1, 1000, [['key', 'c']]))
    expect(r.unused).toBeUndefined()
    expect(formatReport(r)).toMatch(/skipped: the app source was not found/)
  })

  it('reads the offer off a small source tree, and ignores tests and the splash', () => {
    const src = mkdtempSync(join(tmpdir(), 'olp-src-'))
    mkdirSync(join(src, 'splash'))
    writeFileSync(
      join(src, 'App.tsx'),
      "const b = [{ combo: 'mod+z', description: 'Undo', domain: 'project', run: x }, {\n combo: 'f', description: 'Freeze', domain: 'trim' }, { combo: '\\\\', description: 'Fit', domain: 'view' }]\n",
    )
    writeFileSync(
      join(src, 'Panel.tsx'),
      [
        '<button data-testid="do-it" onClick={() => go(a > b)}>x</button>',
        '<div data-testid="just-a-box" className="box" />',
        '<div data-testid="draggy" onPointerDown={drag} />',
        '<button data-testid={`tile-${id}`} onClick={pick}>x</button>',
        '<IconButton label="Zoom in" onClick={z}><Z /></IconButton>',
        '<IconButton label="Has a testid" data-testid="named" onClick={z}><Z /></IconButton>',
        "updateActiveSequence('Cut it', (s) => s)",
        "dispatch(\n  'Mend it',\n  fn)",
      ].join('\n'),
    )
    writeFileSync(join(src, 'Panel.test.tsx'), '<button data-testid="from-a-test" onClick={x}>x</button>')
    writeFileSync(join(src, 'splash', 'splash.ts'), '<button data-testid="splash-melon" onClick={x}>x</button>')
    const c = scanCatalog(src)
    // A backslash key is written '\\' in the source and is one backslash to the keymap.
    expect([...c.shortcuts]).toEqual([['mod+z', 'Undo'], ['f', 'Freeze'], ['\\', 'Fit']])
    expect([...c.controls.keys()].sort()).toEqual(['do-it', 'draggy', 'named'])
    expect([...c.families.keys()]).toEqual(['tile-'])
    expect([...c.labels.keys()]).toEqual(['Zoom in'])
    expect([...c.edits].sort()).toEqual(['Cut it', 'Mend it'])
  })

  it('finds a real catalog in the app source', () => {
    const c = scanCatalog(REPO_SRC)
    expect(c.shortcuts.size).toBeGreaterThan(40)
    expect(c.shortcuts.get('mod+z')).toBe('Undo')
    expect(c.controls.size).toBeGreaterThan(100)
    expect(c.controls.has('settings-usage-log')).toBe(true)
    expect(c.edits.has('Split clip')).toBe(true)
  })
})

describe('paths', () => {
  it('finds what he does in a row, and leaves out the edit a key caused', () => {
    let t = DAY1
    const events = []
    // Four times: press C, the edit it caused lands 20ms later, then he opens the Inspector tab.
    for (let i = 0; i < 4; i++) {
      events.push({ t, s: 's', k: 'key', a: 'c' }, { t: t + 20, s: 's', k: 'edit', a: 'Split clip' }, { t: t + 2_000, s: 's', k: 'ui', a: 'tab-effects' })
      t += 60_000
    }
    const r = buildReport(events)
    expect(r.paths.pairs[0]).toEqual({ path: 'key c  >  ui tab-effects', count: 4 })
    expect(JSON.stringify(r.paths)).not.toMatch(/Split clip/)
  })

  it('does not join two stretches of work that are far apart', () => {
    const events = []
    for (let i = 0; i < 5; i++) events.push({ t: DAY1 + i * 10 * 60_000, s: 's', k: 'key', a: i % 2 ? 'a' : 'b' })
    expect(buildReport(events).paths.pairs).toEqual([])
  })
})

describe('friction', () => {
  it('finds an edit undone within seconds, by the age the app measured, else by the edit just before', () => {
    const events = run(DAY1, 30_000, [
      ['edit', 'Split clip'],
      ['history', 'undo', { of: 'Split clip', age: 1.4 }],
      ['edit', 'Split clip'],
      ['history', 'undo', { of: 'Split clip', age: 600 }], // a change of mind, an age later
      ['edit', 'Move clip'],
      ['history', 'undo', { of: 'Move clip' }], // no age: the edit 30s before is too old
    ])
    const r = buildReport(events)
    expect(r.friction.undoneFast).toEqual([{ name: 'Split clip', undone: 1, made: 2 }])
    const close = run(DAY1, 2_000, [['edit', 'Crossfade'], ['history', 'undo', { of: 'Crossfade' }]])
    expect(buildReport(close).friction.undoneFast).toEqual([{ name: 'Crossfade', undone: 1, made: 1 }])
  })

  it('finds an edit tried again straight after an undo', () => {
    const r = buildReport(
      run(DAY1, 3_000, [
        ['edit', 'Whip transition'],
        ['history', 'undo', { of: 'Whip transition', age: 2 }],
        ['edit', 'Whip transition'],
      ]),
    )
    expect(r.friction.triedAgain).toEqual([{ name: 'Whip transition', times: 1 }])
  })

  it('finds the same thing done again and again, a held key included', () => {
    const taps = run(DAY1, 600, Array.from({ length: 8 }, () => ['key', 'arrowright']))
    const held = run(DAY1 + 600_000, 600, [['key', 'arrowleft', { rep: 40 }]])
    const few = run(DAY1 + 900_000, 600, Array.from({ length: 4 }, () => ['key', 's']))
    const r = buildReport([...taps, ...held, ...few])
    expect(r.friction.repeated).toEqual([
      { name: 'key arrowleft', runs: 1, longest: 41, total: 41 },
      { name: 'key arrowright', runs: 1, longest: 8, total: 8 },
    ])
  })

  it('groups the errors shown to him, and says on which days', () => {
    const r = buildReport([
      ...run(DAY1, 1000, [['error', 'Could not save', { src: 'toast' }], ['error', 'Could not save', { src: 'toast' }], ['error', 'Other', { src: 'uncaught' }]]),
      ...run(DAY2, 1000, [['error', 'Could not save', { src: 'toast' }]]),
    ])
    expect(r.friction.errors).toEqual([
      { message: 'Could not save', count: 3 },
      { message: 'Other', count: 1 },
    ])
    expect(r.friction.errorDays).toEqual([
      { day: dayOf(DAY1), count: 3 },
      { day: dayOf(DAY2), count: 1 },
    ])
  })

  it('finds where he pauses longest', () => {
    const items = []
    for (let i = 0; i < 6; i++) items.push(['ui', 'hard-thing'], ['key', 'x'])
    const events = []
    let t = DAY1
    for (const [k, a] of items) {
      events.push({ t, s: 's', k, a })
      t += k === 'ui' ? 20_000 : 2_000
    }
    const r = buildReport(events)
    expect(r.friction.slowSteps[0]).toMatchObject({ name: 'ui hard-thing', count: 6, medianMs: 20_000 })
  })

  it('summarises exports and caption runs', () => {
    const r = buildReport([
      ...run(DAY1, 1000, [
        ['export', 'export', { w: 1080, h: 1920, fps: 30, sec: 40, outcome: 'done', loud: true }, 80_000],
        ['export', 'export', { w: 1080, h: 1920, fps: 30, sec: 40, outcome: 'cancelled', loud: true }, 5_000],
        ['export', 'export', { w: 1920, h: 1080, fps: 60, sec: 10, outcome: 'done', loud: false }, 40_000],
        ['caption', 'transcribe-run', { clips: 2 }, 30_000],
      ]),
    ])
    expect(r.jobs.exports.count).toBe(3)
    expect(r.jobs.exports.outcomes).toEqual({ done: 2, cancelled: 1 })
    expect(r.jobs.exports.medianMs).toBe(60_000)
    expect(r.jobs.exports.maxMs).toBe(80_000)
    expect(r.jobs.exports.secondsToMakeOneSecond).toBe(3)
    expect(r.jobs.exports.formats[0]).toEqual({ format: '1080x1920 @30', count: 2 })
    expect(r.jobs.captions).toEqual({ count: 1, medianMs: 30_000, maxMs: 30_000 })
  })
})

describe('by day and by project', () => {
  const events = [
    ...run(DAY1, 2_000, [['key', 'c', { cmd: 'Split' }], ['key', 'c', { cmd: 'Split' }], ['ui', 'a']], { p: 'aaaa1111-0000' }),
    ...run(DAY2, 2_000, [['key', 'c', { cmd: 'Split' }], ['export', 'export', { outcome: 'done' }, 1000]], { p: 'bbbb2222-0000', s: 'two' }),
    ...run(DAY2 + 60_000, 2_000, [['key', 'v', { cmd: 'Select' }]], { p: undefined, s: 'two' }),
  ]

  it('splits the days, with the top three actions of each', () => {
    const r = buildReport(events)
    expect(r.byDay.map((d) => [d.day, d.events])).toEqual([[dayOf(DAY1), 3], [dayOf(DAY2), 3]])
    expect(r.byDay[0].top[0]).toBe('key c  (Split) x2')
  })

  it('splits the projects by the start of their id, and keeps the events with no project apart', () => {
    const r = buildReport(events)
    expect(r.byProject.map((p) => [p.project, p.events])).toEqual([
      ['aaaa1111', 3],
      ['bbbb2222', 2],
      ['(no project)', 1],
    ])
    expect(r.byProject.find((p) => p.project === 'bbbb2222').exports).toBe(1)
  })

  it('can look at one project, or the last few days, counted back from the newest event', () => {
    expect(buildReport(events, { project: 'bbbb' }).overview.actions).toBe(2)
    const recent = buildReport(events, { days: 1 })
    expect(recent.overview.from).toBe(dayOf(DAY2))
    expect(buildReport(events, { project: 'nope' }).empty).toBe(true)
  })
})

describe('the printed report', () => {
  const events = [
    ...run(DAY1, 3_000, [
      ['session', 'start', { v: '3.21.0' }],
      ['key', 'c', { cmd: 'Split at playhead' }],
      ['edit', 'Split clip'],
      ['history', 'undo', { of: 'Split clip', age: 1 }],
      ['ui', 'tab-effects', { panel: 'left', role: 'tab' }],
      ['error', 'Could not save', { src: 'toast' }],
    ]),
  ]

  it('has every section, and nothing but plain ASCII, so no dash that is not a hyphen', () => {
    const text = formatReport(buildReport(events, { catalog: { shortcuts: new Map([['f', 'Freeze']]), controls: new Map(), families: new Map(), edits: new Set() } }), { sources: '1 file from x' })
    for (const heading of ['OVERVIEW', 'MOST USED ACTIONS, BY COUNT', 'MOST USED ACTIONS, BY TIME', 'SHORTCUTS', 'NEVER USED', 'MOST USED PATHS', 'FRICTION', 'BY DAY', 'BY PROJECT']) {
      expect(text).toContain(heading)
    }
    expect(text).toContain('f  (Freeze)')
    expect(text).toMatch(/^[\x09\x0a\x20-\x7e]*$/)
  })

  it('says plainly when there is nothing to report', () => {
    expect(formatReport(buildReport([]))).toMatch(/No events found/)
  })

  it('reads durations the way a person would', () => {
    expect(fmtDur(4_000)).toBe('4s')
    expect(fmtDur(125_000)).toBe('2m 05s')
    expect(fmtDur(3_900_000)).toBe('1h 05m')
    expect(median([5, 1, 3])).toBe(3)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([])).toBe(0)
  })
})

describe('run from the command line', () => {
  const files = {
    'usage-2026-10-04.jsonl': run(DAY1, 3_000, [['key', 'c', { cmd: 'Split at playhead' }], ['edit', 'Split clip'], ['ui', 'tab-effects', { panel: 'left' }]]),
    'usage-2026-10-05.jsonl': run(DAY2, 3_000, [['key', 'c', { cmd: 'Split at playhead' }]]),
  }

  const snapshot = (dir) => readdirSync(dir).map((n) => `${n}:${statSync(join(dir, n)).size}:${statSync(join(dir, n)).mtimeMs}`)

  it('gives the same report from a copy of the folder as from the folder, and writes nothing', () => {
    const dir = folderWith(files)
    const copy = join(mkdtempSync(join(tmpdir(), 'olp-copy-')), 'Usage log copy')
    cpSync(dir, copy, { recursive: true })
    const before = snapshot(copy)
    const a = execFileSync(process.execPath, [SCRIPT, dir, '--no-catalog'], { encoding: 'utf8' })
    const b = execFileSync(process.execPath, [SCRIPT, copy, '--no-catalog'], { encoding: 'utf8' })
    expect(b.replace(copy, dir)).toBe(a.replace(copy, dir))
    expect(a).toContain('OL PREMIERE USAGE REPORT')
    expect(a).toContain('key c  (Split at playhead)')
    expect(snapshot(copy)).toEqual(before)
  })

  it('prints the same numbers as JSON when asked', () => {
    const dir = folderWith(files)
    const out = JSON.parse(execFileSync(process.execPath, [SCRIPT, dir, '--json', '--no-catalog'], { encoding: 'utf8' }))
    expect(out.files).toBe(2)
    expect(out.report.overview.actions).toBe(4)
    expect(out.report.shortcuts.top[0]).toEqual({ combo: 'c', command: 'Split at playhead', count: 2 })
  })

  it('reads the app source for the never used list by default', () => {
    const dir = folderWith(files)
    const out = execFileSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' })
    expect(out).toMatch(/of \d+ things the app offers/)
    expect(out).toContain('mod+z  (Undo)')
  })

  it('says where it looked when there is nothing there, and exits with an error', () => {
    const errs = []
    const code = main([join(tmpdir(), 'olp-no-such-folder-xyz')], { out: () => {}, err: (s) => errs.push(s) })
    expect(code).toBe(1)
    expect(errs.join('')).toMatch(/Nothing at .*olp-no-such-folder-xyz/)
  })

  it('survives a log that is half written', () => {
    const dir = folderWith({ 'usage-2026-10-04.jsonl': lines(files['usage-2026-10-04.jsonl']) + '{"t":1759570000000,"s":"x","k":"ke' })
    const out = execFileSync(process.execPath, [SCRIPT, dir, '--no-catalog'], { encoding: 'utf8' })
    expect(out).toMatch(/1 unreadable line skipped/)
    expect(out).toContain('OVERVIEW')
    expect(readFileSync(join(dir, 'usage-2026-10-04.jsonl'), 'utf8').endsWith('"ke')).toBe(true)
  })
})
