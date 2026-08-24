// The desktop splash window's whole program.
//
// It draws the same card as the in-app loading screen, but standalone: no React,
// no store, no editor bundle, so the window can be on screen before the app has
// finished reading itself off disk. That is the point of a splash. It imports only
// `bootCopy.ts`, which has no dependencies of its own, and never `bootProgress.ts`,
// which would drag the zustand ledger in here with it.
//
// The rows are still driven by REAL work. The editor's renderer reports each step
// to the main process, which forwards it here, so this window is a view of the
// same honest ledger rather than a timer pretending to load something.

import { MELON_PALETTE } from '../ui/melon'
import { melonSvg } from './melonSvg'
import { BACKGROUND_TITLE, GATING_TITLE, LEGAL_LINE, MARK, cursorIndex, splitRows } from '../ui/bootCopy'
import type { BootStepState } from '../ui/bootProgress'
import { SPLASH_CARD_EXIT_MS } from '../../electron/ipc-types'
import '@fontsource-variable/figtree'
import '@fontsource/jetbrains-mono'
import './splash.css'

interface SplashRow {
  id: string
  label: string
  state: BootStepState
  /** True for a row the app does not wait for. Decides which group it is drawn in. */
  optional?: boolean
}

interface SplashProgress {
  rows: SplashRow[]
  line: string
  percent: number
  /**
   * How many rows that HOLD THE APP SHUT have settled, out of how many there are.
   * Counted once, by the editor (`gatingCount`), and sent, rather than recounted
   * here: this window and the in-app card must never be able to disagree about
   * how full the bar is.
   */
  settled: number
  total: number
  version: string
}

const reducedMotion = (): boolean => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

const root = document.getElementById('root')!
root.innerHTML = `
  <div class="card" data-testid="splash-card">
    <div class="brand">
      <span class="brandMark">
        <span class="glow"></span>
        ${melonSvg()}
      </span>
      <p class="wordmark">OL <span class="wordmarkStrong">Premiere</span></p>
      <p class="version" id="version"></p>
    </div>
    <div class="panel">
      <p class="groupTitle">${GATING_TITLE}</p>
      <ul class="steps" id="stepsGating" data-group="gating"></ul>
      <p class="groupTitle groupLater" id="laterTitle">${BACKGROUND_TITLE}</p>
      <ul class="steps" id="stepsLater" data-group="background"></ul>
    </div>
    <div class="footer">
      <div class="bar" id="bar" role="progressbar" aria-label="Startup progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"></div>
      <div class="footRow">
        <p class="status" id="status">${GATING_TITLE}</p>
        <p class="count" id="count"></p>
      </div>
      <p class="legal">${LEGAL_LINE}</p>
    </div>
  </div>
`

const gatingEl = document.getElementById('stepsGating')!
const laterEl = document.getElementById('stepsLater')!
const laterTitleEl = document.getElementById('laterTitle')!
const barEl = document.getElementById('bar')!
const statusEl = document.getElementById('status')!
const countEl = document.getElementById('count')!
const versionEl = document.getElementById('version')!

interface RowEls {
  li: HTMLElement
  mark: HTMLElement
  text: HTMLElement
}

// The rows and the bar segments are built ONCE and then patched in place. Rewriting
// innerHTML on every message restarts every CSS animation in the card, which turned
// the lit row's entrance and the mark's pulse into a stutter at whatever rate the
// editor happened to be reporting at.
const rowEls = new Map<string, RowEls>()
let builtRowIds = ''
let builtSegs = -1
/** Set once the card has been replaced by the melon: nothing left to patch. */
let cardGone = false

function rowHtml(row: SplashRow): string {
  return `<li class="step" data-step="${row.id}"><span class="mark"></span><span class="stepText"></span></li>`
}

function buildRows(rows: SplashRow[]): void {
  const ids = rows.map((r) => r.id).join(',')
  if (ids === builtRowIds) return
  builtRowIds = ids
  rowEls.clear()
  const { gating, background } = splitRows(rows)
  gatingEl.innerHTML = gating.map(rowHtml).join('')
  laterEl.innerHTML = background.map(rowHtml).join('')
  // The web build has no update row, and a build could one day have no background
  // rows at all. An empty heading over nothing would be worse than no heading.
  const showLater = background.length > 0 ? '' : 'none'
  laterTitleEl.style.display = showLater
  laterEl.style.display = showLater
  for (const row of rows) {
    const li = root.querySelector<HTMLElement>(`li[data-step="${row.id}"]`)
    const mark = li?.querySelector<HTMLElement>('.mark')
    const text = li?.querySelector<HTMLElement>('.stepText')
    if (li && mark && text) rowEls.set(row.id, { li, mark, text })
  }
}

function buildSegs(total: number): void {
  if (total === builtSegs) return
  builtSegs = total
  barEl.innerHTML = Array.from({ length: total }, () => '<span class="seg"></span>').join('')
}

function render(p: SplashProgress): void {
  if (cardGone) return
  versionEl.textContent = p.version ? `Version ${p.version}` : ''
  statusEl.textContent = p.line
  countEl.textContent = `${p.settled} of ${p.total}`

  buildSegs(p.total)
  barEl.setAttribute('aria-valuenow', String(p.percent))
  barEl.setAttribute('aria-valuetext', `${p.settled} of ${p.total} startup steps`)
  const segs = barEl.children
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i] as HTMLElement
    setFlag(seg, 'fill', i < p.settled)
    setFlag(seg, 'lead', i === p.settled - 1)
  }

  buildRows(p.rows)
  const cursor = cursorIndex(p.rows.map((r) => r.state))
  const cursorId = cursor >= 0 ? p.rows[cursor].id : null
  for (const row of p.rows) {
    const els = rowEls.get(row.id)
    if (!els) continue
    if (els.li.dataset.state !== row.state) els.li.dataset.state = row.state
    setFlag(els.li, 'cursor', row.id === cursorId)
    const mark = MARK[row.state]
    if (els.mark.textContent !== mark) els.mark.textContent = mark
    // textContent, so a label can carry any character a detail puts in it without
    // this page having to strip it back out first.
    if (els.text.textContent !== row.label) els.text.textContent = row.label
  }
}

/** Set or clear a data flag, and only when it actually changed: writing the same
 *  attribute back would restart the animation keyed off it. */
function setFlag(el: HTMLElement, name: string, on: boolean): void {
  const has = el.dataset[name] === 'true'
  if (has === on) return
  if (on) el.dataset[name] = 'true'
  else delete el.dataset[name]
}

window.api?.onBootProgress?.(render)

// --- beat two: the card leaves and the melon becomes the door -----------------
//
// His ask: when the startup finishes, the app does not just appear. The card pops,
// the window pulls in to a small square on his desktop, and the melon sits there
// waiting. Clicking the fruit is what opens the editor. Nothing here is a timer
// racing the app: main tells us the real work is done, and then it waits for him.

let leaving = false
let launched = false

function showMelon(): void {
  cardGone = true
  // Shrink the window FIRST, so the melon's entrance plays at its final size
  // rather than growing inside a 700px box and then being cropped to a square.
  window.api?.splashShrink?.()
  root.innerHTML = `
    <div class="melonStage" data-testid="splash-melon-stage">
      <button type="button" class="melonBtn" data-testid="splash-melon" aria-label="Open OL Premiere" title="Open OL Premiere">
        <span class="halo" aria-hidden="true"></span>
        ${melonSvg('melonHero')}
      </button>
    </div>
  `
  const btn = root.querySelector<HTMLButtonElement>('.melonBtn')!
  btn.addEventListener('click', launch)
  btn.focus() // so Enter or Space opens it too, without reaching for the mouse
}

function launch(): void {
  if (launched) return
  launched = true
  // The editor is asked for NOW and the pop plays over it: main keeps this window
  // alive for exactly the length of the animation.
  root.querySelector('.melonStage')?.classList.add('leaving')
  window.api?.splashEnter?.()
}

function bootReady(): void {
  if (leaving) return
  leaving = true
  const card = root.querySelector('.card')
  if (!card || reducedMotion()) {
    showMelon()
    return
  }
  card.classList.add('leaving')
  window.setTimeout(showMelon, SPLASH_CARD_EXIT_MS)
}

window.api?.onBootReady?.(bootReady)

// Colour tokens the card borrows from the app, inlined so this page pulls in no
// stylesheet of the editor's.
document.documentElement.style.setProperty('--melon-flesh', MELON_PALETTE.R)
