// @vitest-environment jsdom
//
// The rules that keep his material OUT of the usage log, and the scans of the real
// source that fail when a new label or testid would put it back in.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  dialogName,
  editAction,
  extensionSummary,
  maskMessage,
  NAMED_VERB_LABELS,
  panelOf,
  setKnownNames,
  testIdName,
  uiName,
  type KnownName,
} from './usageNames'

afterEach(() => {
  setKnownNames(() => [])
  document.body.innerHTML = ''
})

const html = (s: string): HTMLElement => {
  document.body.innerHTML = s
  return document.body
}

describe('edit names', () => {
  it('lets the plain labels through exactly as the Undo toast says them', () => {
    for (const label of ['Split clip', 'Add marker', 'Delete clip', 'Set aspect ratio', 'Edit title', 'Clear in/out']) {
      expect(editAction(label)).toEqual({ kind: 'edit', a: label })
    }
  })

  it('turns an import into a count', () => {
    expect(editAction('Import 3 file(s)')).toEqual({ kind: 'import', a: 'Import files', d: { n: 3 } })
    expect(editAction('Remove 2 unused files')).toEqual({ kind: 'edit', a: 'Remove unused files', d: { n: 2 } })
  })

  it('takes a file name out of "Add", "Delete", "Place" and "Listen to"', () => {
    expect(editAction('Add intro take 2.mp4')).toEqual({ kind: 'edit', a: 'Add <name>' })
    expect(editAction('Delete Gym day.mov')).toEqual({ kind: 'edit', a: 'Delete <name>' })
    expect(editAction('Place voiceover.webm')).toEqual({ kind: 'edit', a: 'Place <name>' })
    expect(editAction('Listen to interview.wav')).toEqual({ kind: 'edit', a: 'Listen to <name>' })
  })

  it('takes a track, a library item, a preset and a caption style out of their labels', () => {
    expect(editAction('Sync Music bed').a).toBe('Sync track')
    expect(editAction('Unsync Music bed').a).toBe('Unsync track')
    expect(editAction('Add Whoosh from Library').a).toBe('Add <item> from Library')
    expect(editAction('Apply preset Warm skin to all clips').a).toBe('Apply preset to all clips')
    expect(editAction('Apply preset Warm skin').a).toBe('Apply preset')
    expect(editAction('Apply track setup "My shorts"').a).toBe('Apply track setup')
    expect(editAction('Apply "Bold yellow"').a).toBe('Apply caption style')
  })

  it('says which kind of thing a known name was, when it can', () => {
    const names: KnownName[] = [
      { name: 'beach day.mp4', as: 'media' },
      { name: 'Voice over', as: 'track' },
    ]
    setKnownNames(() => names)
    expect(editAction('Delete beach day.mp4').a).toBe('Delete <media>')
    expect(editAction('Delete Voice over').a).toBe('Delete <track>')
    expect(editAction('Some edit of beach day.mp4 and more').a).toBe('Some edit of <media> and more')
  })

  it('takes a short name only as a whole word, so it cannot match inside other words', () => {
    setKnownNames(() => [
      { name: 'V1', as: 'track' },
      { name: 'Mic', as: 'track' },
    ])
    expect(editAction('Move clip').a).toBe('Move clip')
    expect(editAction('Delete V1').a).toBe('Delete <track>')
    expect(maskMessage('Mic volume')).toBe('<track> volume')
    expect(maskMessage('Microphone volume')).toBe('Microphone volume')
  })

  it('masks any quoted name that no rule knew about', () => {
    expect(editAction('Frobnicate "my secret"').a).toBe('Frobnicate "\u2026"')
  })
})

describe('message masking', () => {
  it('masks quoted names, paths and file names, and folds numbers', () => {
    expect(maskMessage('Opened "Gym day 4". Your newer "Gym day 3" was kept.')).toBe('Opened "\u2026". Your newer "\u2026" was kept.')
    expect(maskMessage('Could not read C:\\Users\\skyle\\Desktop\\secret film.mp4: no such file')).not.toMatch(/skyle|secret|film/)
    expect(maskMessage('Export finished: My holiday cut v2.mp4 (12.3 MB)')).toBe('Export finished: <file.mp4> (# MB)')
    expect(maskMessage('No sound from beach.mov. The rest of the audio exported.')).toBe('No sound from <file.mov>. The rest of the audio exported.')
    expect(maskMessage('Imported 5 files in 12.5 s')).toBe('Imported # files in # s')
  })

  it('takes the words in front of a file name as well, up to the word that points at it', () => {
    expect(maskMessage('Media for 2026-09-20 14-12-28.mp4 is missing from local storage')).toBe('Media for <file.mp4> is missing from local storage')
    expect(maskMessage('Could not play my gym video final.mp4')).toBe('Could not play <file.mp4>')
  })

  it('does not take a version number or a sentence for a file', () => {
    expect(maskMessage('Updated to v3.21.0. You are on the newest version')).toBe('Updated to v#. You are on the newest version')
    expect(maskMessage('Saved. Next, export it.')).toBe('Saved. Next, export it.')
  })

  it('masks the names of his material wherever they appear', () => {
    setKnownNames(() => [
      { name: 'Quarterly review', as: 'project' },
      { name: 'Whoosh', as: 'item' },
    ])
    expect(maskMessage('The export of Quarterly review failed')).toBe('The export of <project> failed')
    expect(maskMessage('No unlocked video track for Whoosh')).toBe('No unlocked video track for <item>')
  })

  it('is short and on one line', () => {
    const m = maskMessage('line one\nline two ' + 'word '.repeat(60))
    expect(m).not.toContain('\n')
    expect(m.length).toBeLessThanOrEqual(91)
  })
})

describe('naming a control', () => {
  it('prefers the testid, then the aria-label, then the visible text of a plain button', () => {
    const b = html(`
      <button id="a" data-testid="snap-toggle" aria-label="Snapping">Snap</button>
      <button id="b" aria-label="Zoom in">+</button>
      <button id="c">Split</button>`)
    expect(uiName(b.querySelector('#a')!)).toEqual({ a: 'snap-toggle', role: 'button' })
    expect(uiName(b.querySelector('#b')!).a).toBe('Zoom in')
    expect(uiName(b.querySelector('#c')!).a).toBe('Split')
  })

  it('never names a button by text that sits in his own material', () => {
    const b = html(`
      <div data-testid="asset-card"><button id="x">intro take 2.mp4</button></div>
      <div data-testid="track-header-Music bed"><button id="y">Music bed</button></div>`)
    expect(uiName(b.querySelector('#x')!).a).toBe('asset-card>button')
    expect(uiName(b.querySelector('#y')!).a).toBe('track-header-*>button')
  })

  it('cuts a testid down to its family when the tail is his', () => {
    expect(testIdName('track-header-Music bed')).toBe('track-header-*')
    expect(testIdName('track-sync-Voice')).toBe('track-sync-*')
    expect(testIdName('locate-3f9a1c22-77d1-4b8e-9d1a-0123456789ab')).toBe('locate-*')
    expect(testIdName('projects-tab-9c1e4f0a2b')).toBe('projects-tab-*')
    expect(testIdName('settings-snapping')).toBe('settings-snapping')
    expect(testIdName('move-tile-punch')).toBe('move-tile-punch')
    expect(testIdName('clip-3f9a1c22-77d1')).toBe('clip-*')
  })

  it('masks an aria-label that names something of his', () => {
    const b = html('<button id="x" aria-label=\'Delete "Bold yellow"\'>x</button>')
    expect(uiName(b.querySelector('#x')!).a).toBe('Delete "\u2026"')
  })

  it('lets an element say its own name, or ask never to be named', () => {
    const b = html('<button id="x" data-usage="my-name">anything</button><button id="y" data-usage="">secret words</button>')
    expect(uiName(b.querySelector('#x')!).a).toBe('my-name')
    expect(uiName(b.querySelector('#y')!).a).toBe('button')
  })

  it('names the part of the app a control is in', () => {
    const b = html(`
      <header data-testid="topbar"><button id="a">Export</button></header>
      <aside data-testid="panel-left"><button id="b">Add</button></aside>
      <div role="dialog" aria-label="Settings" data-testid="settings-dialog"><button id="c">On</button></div>
      <div role="menu"><button id="d" role="menuitem">Split</button></div>
      <p><button id="e">Loose</button></p>`)
    expect(panelOf(b.querySelector('#a')!)).toBe('topbar')
    expect(panelOf(b.querySelector('#b')!)).toBe('left')
    expect(panelOf(b.querySelector('#c')!)).toBe('dialog:settings-dialog')
    expect(panelOf(b.querySelector('#d')!)).toBe('menu')
    expect(panelOf(b.querySelector('#e')!)).toBe('app')
    expect(dialogName(b.querySelector('[role="dialog"]')!)).toBe('settings-dialog')
  })
})

describe('extensions of an import', () => {
  it('lists the kinds and how many, never the names', () => {
    expect(extensionSummary(['a.mp4', 'b.MP4', 'c.mov', 'd'])).toBe('mp4:2 ?:1 mov:1')
    expect(extensionSummary([])).toBe('')
  })
})

// --- Scans of the real source -----------------------------------------------------------

const SRC = join(__dirname, '..')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sourceFiles(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|\.d\.ts$|Fixtures/.test(name)) out.push(p)
  }
  return out
}

const FILES = sourceFiles(SRC).map((p) => ({ path: p, text: readFileSync(p, 'utf8') }))

/** The text of an opening tag starting at `from`, up to the `>` that closes it. */
function openingTag(text: string, from: number): string {
  let depth = 0
  let quote = ''
  for (let i = from + 1; i < Math.min(text.length, from + 4000); i++) {
    const c = text[i]!
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = ''
    } else if (c === '"' || c === "'" || c === '`') quote = c
    else if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0 && text[i - 1] !== '=') return text.slice(from, i + 1)
  }
  return text.slice(from, from + 600)
}

describe('every label in the source', () => {
  const STATIC = /(?:dispatch|updateActiveSequence)\(\s*'([^'\n]+)'/g
  // A template label: the back-tick string right after the call. Expressions inside ${} hold no back-ticks here.
  const TEMPLATE = /(?:dispatch|updateActiveSequence)\(\s*`([^`]*\$\{[^`]*)`/g

  it('passes a plain label through unchanged, so the report reads like the Undo toast', () => {
    const changed: string[] = []
    let seen = 0
    for (const { text } of FILES) {
      for (const m of text.matchAll(STATIC)) {
        seen += 1
        if (editAction(m[1]!).a !== m[1]) changed.push(m[1]!)
      }
    }
    expect(seen).toBeGreaterThan(30)
    // A plain label that starts with Add, Delete, Place or Listen to would be read as
    // "verb + a name of his". If one lands here, add it to NAMED_VERB_LABELS.
    expect(changed).toEqual([])
    expect(NAMED_VERB_LABELS.size).toBeGreaterThan(0)
  })

  it('never lets a name of his through a template label', () => {
    const leaked: string[] = []
    let seen = 0
    for (const { path, text } of FILES) {
      for (const m of text.matchAll(TEMPLATE)) {
        seen += 1
        // A number in the slot stays a number; anything else is a stand in for a name.
        const sample = m[1]!.replace(/\$\{([^}]*)\}/g, (_all, expr: string) => {
          if (/\.length|^n$|^factor$|[cC]ount\b/.test(expr.trim())) return '7'
          // A choice between two words ('Unsync' or 'Sync') is the app's own, not his.
          const word = /\?\s*'([^']+)'/.exec(expr)
          return word ? word[1]! : 'CANARYNAME'
        })
        if (editAction(sample).a.includes('CANARY')) leaked.push(`${path.replace(SRC, 'src')}: ${m[1]}`)
      }
    }
    expect(seen).toBeGreaterThan(10)
    expect(leaked).toEqual([])
  })
})

describe('every dynamic testid in the source', () => {
  /** Dynamic testids whose last part is something the APP chose: an id from its own tables. */
  const APP_CHOSEN = new Set([
    'caption-style-pos-',
    'channel-',
    'curve-chip-',
    'drop-move-',
    'ease-',
    'fade-',
    'forget-move-',
    'gizmo-corner-rotate-',
    'gizmo-edge-',
    'gizmo-handle-',
    'move-glyph-',
    'move-live-',
    'move-tape-',
    'move-tile-',
    'phone-tab-',
    'reset-section-',
    'shared-channel-',
    'stopwatch-',
    'tab-',
    'theme-',
    'title-swatch-',
  ])

  it('is either chosen by the app, or cut down to its family', () => {
    const unknown: string[] = []
    for (const { path, text } of FILES) {
      for (const m of text.matchAll(/data-testid=\{`([^`]*)`\}/g)) {
        const head = m[1]!.split('${')[0]!
        if (head === '') continue // `${testId}-input`: built from a static testid passed in
        if (APP_CHOSEN.has(head)) continue
        // His: it must reduce to its family with nothing after the dash.
        if (testIdName(`${head}Some Name Of His`) === `${head}*`) continue
        unknown.push(`${path.replace(SRC, 'src')}: ${m[1]}`)
      }
    }
    // A new dynamic testid is a decision: is its tail the app's (add it above) or his
    // (add its family to USER_TESTID_FAMILIES in usageNames.ts)?
    expect(unknown).toEqual([])
  })
})

describe('every aria-label that holds a name of his', () => {
  // Names of media, tracks, library items, presets and the project are masked by what the log
  // knows of them (usageWiring knownNames), whatever the control is. These are not.
  const HIS = /\$\{[^}]*\b(style|clip|word|caption)\.(name|text)\b[^}]*\}/

  it('sits on a control that has a testid or says its own name', () => {
    const unnamed: string[] = []
    for (const { path, text } of FILES) {
      for (const m of text.matchAll(/(?:aria-label|label|title)=\{`([^`]*)`\}/g)) {
        if (!HIS.test(m[1]!)) continue
        // A quoted name is masked by maskMessage whatever the control is.
        if (/["\u201c]\$\{/.test(m[1]!)) continue
        const lt = text.lastIndexOf('<', m.index)
        const tag = openingTag(text, lt)
        if (!/data-testid|data-usage/.test(tag)) unnamed.push(`${path.replace(SRC, 'src')}: ${m[1]}`)
      }
    }
    expect(unnamed).toEqual([])
  })
})
