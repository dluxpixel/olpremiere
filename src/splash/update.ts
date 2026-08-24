// The update window's whole program.
//
// It is splash.ts with a different feed. Same card, same classes, same stylesheet,
// same build-once-then-patch discipline, and the same import rule: bootCopy.ts and
// updateCopy.ts have no dependencies, appVersion.ts is pure, and nothing here
// reaches into src/state.

import { MARK, cursorIndex } from '../ui/bootCopy'
import { updateCount, updateRows, updateStatusLine, updateTitle } from '../ui/updateCopy'
import { melonSvg } from './melonSvg'
import {
  SPLASH_CARD_EXIT_MS,
  UPDATE_BAR_SEGMENTS,
  UPDATE_CARD_HOLD_MS,
  UPDATE_STALL_MS,
  type UpdateStatus,
} from '../../electron/ipc-types'
import { displayVersion } from '../appVersion'
import '@fontsource-variable/figtree'
import '@fontsource/jetbrains-mono'
import './splash.css'

const reducedMotion = (): boolean => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
const mb = (bytes: number): number => Math.round(bytes / 1_000_000)

const root = document.getElementById('root')!

// Written ONCE. Every frame after this touches attributes and textContent only,
// because rewriting innerHTML restarts every CSS animation in the card, which is
// what turned the lit row's entrance and the mark's pulse into a stutter. The
// segments are here rather than built later for the same reason, and because their
// count never changes.
root.innerHTML = `
  <div class="card" data-card="update" data-testid="update-card">
    <div class="brand">
      <span class="brandMark">
        <span class="glow"></span>
        ${melonSvg('melon', { bite: true })}
      </span>
      <p class="wordmark">OL <span class="wordmarkStrong">Premiere</span></p>
      <p class="version" id="version"></p>
    </div>
    <div class="panel">
      <p class="groupTitle" id="title"></p>
      <ul class="steps" id="steps" data-group="update">
        <li class="step" data-step="check"><span class="mark"></span><span class="stepText"></span></li>
        <li class="step" data-step="download"><span class="mark"></span><span class="stepText"></span></li>
      </ul>
    </div>
    <div class="footer">
      <div class="bar" id="bar" role="progressbar" aria-label="Update download" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        ${Array.from({ length: UPDATE_BAR_SEGMENTS }, () => '<span class="seg"></span>').join('')}
      </div>
      <div class="footRow">
        <p class="status" id="status"></p>
        <p class="count" id="count"></p>
      </div>
    </div>
  </div>
`
// ⛔ NO .legal LINE. "Local-first · your media never leaves this machine" is the boot
// card's signature and it is true there. Under a 240 MB installer arriving from
// GitHub it is the one line on this card that reads wrong, so it is not on it.

const versionEl = document.getElementById('version')!
const titleEl = document.getElementById('title')!
const barEl = document.getElementById('bar')!
const statusEl = document.getElementById('status')!
const countEl = document.getElementById('count')!
const rowEls = new Map<string, { li: HTMLElement; mark: HTMLElement; text: HTMLElement }>()
for (const li of root.querySelectorAll<HTMLElement>('li.step')) {
  rowEls.set(li.dataset.step!, {
    li,
    mark: li.querySelector<HTMLElement>('.mark')!,
    text: li.querySelector<HTMLElement>('.stepText')!,
  })
}

let version = ''
let percent = 0
let doneMb = 0
let totalMb = 0
let settling = false
let cardGone = false
// `number`, not ReturnType<typeof setTimeout>: node types are in scope here and
// would widen this to Timeout, which window.setTimeout does not return.
let stall: number | null = null

/**
 * Set or clear a data flag, and only when it actually changed: writing the same
 * attribute back restarts the animation keyed off it.
 */
function setFlag(el: HTMLElement, name: string, on: boolean): void {
  const has = el.dataset[name] === 'true'
  if (has === on) return
  if (on) el.dataset[name] = 'true'
  else delete el.dataset[name]
}

function render(s: UpdateStatus): void {
  if (cardGone) return
  if ('version' in s) version = displayVersion(s.version)

  // MONOTONIC. electron-updater reports a lower percent when a connection resumes,
  // and a bar that goes backwards is worse than a bar that lies.
  if (s.kind === 'downloading') {
    percent = Math.max(percent, Math.min(100, s.percent))
    if (s.total) totalMb = Math.max(totalMb, mb(s.total))
    if (s.transferred) doneMb = Math.max(doneMb, Math.min(totalMb || Infinity, mb(s.transferred)))
  }
  if (s.kind === 'downloaded') {
    percent = 100
    doneMb = totalMb
  }

  versionEl.textContent = version ? `Version ${displayVersion()} → ${version}` : ''
  titleEl.textContent = updateTitle(version)
  const line = updateStatusLine(s, version)
  if (statusEl.textContent !== line) statusEl.textContent = line
  const count = updateCount(doneMb, totalMb, percent)
  if (countEl.textContent !== count) countEl.textContent = count

  const filled = Math.floor((percent * UPDATE_BAR_SEGMENTS) / 100)
  barEl.setAttribute('aria-valuenow', String(percent))
  barEl.setAttribute('aria-valuetext', `${count} downloaded`)
  for (let i = 0; i < barEl.children.length; i++) {
    const seg = barEl.children[i] as HTMLElement
    setFlag(seg, 'fill', i < filled)
    // At 0% `filled - 1` is -1, so nothing is lead and nothing glows. A coral smudge
    // before a single byte has landed would be claiming motion that has not started.
    setFlag(seg, 'lead', i === filled - 1)
  }

  const rows = updateRows(s)
  const cursor = cursorIndex(rows.map((r) => r.state))
  const cursorId = cursor >= 0 ? rows[cursor].id : null
  for (const row of rows) {
    const els = rowEls.get(row.id)
    if (!els) continue
    if (els.li.dataset.state !== row.state) els.li.dataset.state = row.state
    setFlag(els.li, 'cursor', row.id === cursorId)
    if (els.mark.textContent !== MARK[row.state]) els.mark.textContent = MARK[row.state]
    if (els.text.textContent !== row.label) els.text.textContent = row.label
  }

  // ⛔ NO ROW IS LIT ONCE IT IS DONE. cursorIndex over ['done','done'] returns -1 and
  // that is correct: a row still shouting next to a finished bar would be claiming to
  // be busy. The status line carries the last beat.

  armStall()
  if (!settling && (s.kind === 'downloaded' || s.kind === 'error')) {
    settling = true
    if (stall) clearTimeout(stall)
    stall = null
    window.setTimeout(() => finish(s.kind === 'downloaded'), UPDATE_CARD_HOLD_MS)
  }
}

/**
 * No progress for UPDATE_STALL_MS and no answer either: leave, quietly. The window
 * is frameless, always-on-top and has no close button, so it must never be able to
 * sit on 63% forever. It says nothing on the way out because nothing has reported a
 * failure; the toast path still owns whatever really happened.
 */
function armStall(): void {
  if (settling) return
  if (stall) clearTimeout(stall)
  stall = window.setTimeout(() => finish(false), UPDATE_STALL_MS)
}

function finish(ok: boolean): void {
  const card = root.querySelector('.card')
  if (!card || reducedMotion()) {
    if (ok) showMelon()
    else window.api?.updateDismiss?.()
    return
  }
  card.classList.add('leaving')
  window.setTimeout(() => (ok ? showMelon() : window.api?.updateDismiss?.()), SPLASH_CARD_EXIT_MS)
}

function showMelon(): void {
  cardGone = true
  // Shrink FIRST, so melonIn plays at final size instead of growing inside a 700px
  // box and being cropped to a square.
  window.api?.updateShrink?.()
  root.innerHTML = `
    <div class="melonStage" data-testid="update-melon-stage">
      <button type="button" class="melonBtn" data-testid="update-melon">
        <span class="halo" aria-hidden="true"></span>
        ${melonSvg('melonHero', { bite: true })}
      </button>
    </div>
  `
  const btn = root.querySelector<HTMLButtonElement>('.melonBtn')!
  // setAttribute after insertion, never interpolated into the template above: the
  // version is a value off the update feed, not a constant.
  const label = `Restart into OL Premiere ${version}`
  btn.setAttribute('aria-label', label)
  btn.setAttribute('title', label)
  btn.addEventListener('click', apply)
  btn.focus() // inside this document only, main never focuses this window
}

let applied = false
function apply(): void {
  if (applied) return
  applied = true
  root.querySelector('.melonStage')?.classList.add('leaving')
  // ⛔ NOT update:install, which is a bare quitAndInstall with no busy check at all.
  // This routes into the renderer's existing decision, isRestartUnsafe then saveNow
  // then restart, so the melon can never quit through an in-flight export or an
  // unsaved edit.
  window.api?.updateApply?.()
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.api?.updateDismiss?.()
})

// PULL AND SUBSCRIBE, BOTH. The check runs in main before this page exists, so a
// page that only listened would sit on 0% forever.
window.api?.onUpdateStatus?.(render)
void window.api?.getUpdateStatus?.().then(render, () => {})
// Painted. main holds the window hidden until this fires, so the card is never seen
// empty and the bar never fades up from zero on its first frame.
window.api?.updateShow?.()
armStall()
