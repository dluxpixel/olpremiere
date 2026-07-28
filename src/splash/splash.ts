// The desktop splash window's whole program.
//
// It draws the same card as the in-app loading screen, but standalone: no React,
// no store, no editor bundle, so the window can be on screen before the app has
// finished reading itself off disk. That is the point of a splash.
//
// The rows are still driven by REAL work. The editor's renderer reports each step
// to the main process, which forwards it here, so this window is a view of the
// same honest ledger rather than a timer pretending to load something.

import { MELON_H, MELON_PALETTE, MELON_W, melonPixels } from '../ui/melon'
import type { BootStepState } from '../ui/bootProgress'
import { SPLASH_CARD_EXIT_MS } from '../../electron/ipc-types'
import '@fontsource-variable/figtree'
import '@fontsource/jetbrains-mono'
import './splash.css'

interface SplashRow {
  id: string
  label: string
  state: BootStepState
}

interface SplashProgress {
  rows: SplashRow[]
  line: string
  percent: number
  version: string
}

const MARK: Record<BootStepState, string> = { done: '✓', failed: '!', active: '›', pending: '·' }

function melonSvg(className = 'melon'): string {
  const rects = melonPixels()
    .map((p) => `<rect x="${p.x}" y="${p.y}" width="1" height="1" fill="${p.color}"/>`)
    .join('')
  return `<svg class="${className}" viewBox="0 0 ${MELON_W} ${MELON_H}" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`
}

const reducedMotion = (): boolean => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

const root = document.getElementById('root')!
root.innerHTML = `
  <div class="card" data-testid="splash-card">
    <div class="brand">
      <span class="glow"></span>
      ${melonSvg()}
      <p class="wordmark">OL <span class="strong">Premiere</span></p>
      <p class="version" id="version"></p>
    </div>
    <span class="seam" aria-hidden="true">
      <svg viewBox="0 0 30 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id="seam" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(255,138,108,0.62)"/>
            <stop offset="100%" stop-color="rgba(240,96,76,0.08)"/>
          </linearGradient>
        </defs>
        <line x1="30" y1="0" x2="0" y2="100" stroke="url(#seam)" stroke-width="1" vector-effect="non-scaling-stroke"/>
      </svg>
    </span>
    <div class="panel">
      <p class="panelTitle">Starting up</p>
      <ul class="steps" id="steps"></ul>
    </div>
    <div class="footer">
      <div class="bar"><span class="fill" id="fill"></span></div>
      <div class="footRow">
        <p class="status" id="status">Starting up</p>
        <p class="percent" id="percent">0%</p>
      </div>
      <p class="legal">Local-first · your media never leaves this machine</p>
    </div>
  </div>
`

const stepsEl = document.getElementById('steps')!
const statusEl = document.getElementById('status')!
const percentEl = document.getElementById('percent')!
const fillEl = document.getElementById('fill')!
const versionEl = document.getElementById('version')!

function render(p: SplashProgress): void {
  versionEl.textContent = p.version ? `Version ${p.version}` : ''
  statusEl.textContent = p.line
  percentEl.textContent = `${p.percent}%`
  fillEl.style.width = `${p.percent}%`
  stepsEl.innerHTML = p.rows
    .map(
      (r) =>
        `<li class="step" data-state="${r.state}" data-step="${r.id}"><span class="mark">${
          MARK[r.state]
        }</span><span class="stepText">${r.label.replace(/[<>&]/g, '')}</span></li>`,
    )
    .join('')
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
