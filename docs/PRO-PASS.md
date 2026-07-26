# PRO-PASS: final verification of the pro-feel + design overhaul

Date: 2026-07-20. Worktree: `olpremiere-preview`. This is the integration gate for the
multi-agent redesign pass driven by `OLPREMIERE-PRO-REDESIGN.md`.

## Before / after

Before (the generic AI default the spec calls out in section 1):

- Neutral gray surfaces `#17171a` / `#1e1e22` / `#26262b`
- Inter as the UI font, single-size gray-soup type
- Indigo-violet accent `#6f6bff` on selection, buttons, markers
- No command palette, no quick start, submenus could run off-screen

After (spec section 2, verified on screen):

- Warm near-black studio: app `#0f0e0d`, panel `#141312`, elevated `#1b1a18`,
  input `#232120`; precise 1px borders `#2a2825` / `#3a3733`; no panel shadows,
  no gradients, no glass
- Figtree Variable for UI at 13px base, JetBrains Mono with tabular figures for
  every numeric readout (timecode, durations, meter scale, export estimates);
  uppercase letterspaced section labels
- Lavender `#f0d7ff` primary/selection/focus, ember `#ffa946` live states,
  teal family for audio/success, playhead stays red `#ff4d3d`
- Clip families rebuilt for the warm ground: video deep slate `#2c4a60`, audio
  deep teal `#175249`, image deep plum `#57406a`, title deep magenta `#7c3a6c`,
  each with a brighter top edge; selection is a 2px lavender ring
- Command palette (Ctrl+K), searchable keyboard help, first-run quick start,
  context menus everywhere, toasts with actions
- All fonts self-hosted in `public/fonts` (no CDN); reduced-motion honored via
  a global media-query guard; hovers 120ms, drag paths instant

## Integration fixes made in this final pass

1. `mod+k` conflict: the old "Split at playhead" alias collided with the new
   command palette. Palette wins (spec 3.3); split stays on `c` / `shift+c` /
   `alt+c`. `e2e/phase3.spec.ts` updated to use `c` (the behavioral assert,
   history round-tripping, is unchanged).
2. Context-menu submenus now clamp vertically to the viewport
   (`src/ui/ContextMenu.tsx`). A title clip near the bottom edge used to open
   its Animation flyout off-screen, which made "Save as default" unreachable
   (this is what failed `e2e/appearance.spec.ts`). Proof shot:
   `_verify/pro/context-menu/context-submenu.png`.
3. Escape now closes the Captions and Export dialogs while idle (spec 5,
   keyboard operability). A running export or an active tap-to-time run still
   never cancels from a stray Escape.
4. Last `#6f6bff` remnant retired: the default marker color is now ember
   `#ffa946` (`src/engine/timeline.ts` + its test).
5. Last `Inter` references retired: the default title face and the title font
   dropdown now lead with self-hosted Figtree, registered in the export
   worker's own FontFaceSet so preview == export
   (`src/engine/render/titleFonts.ts`, `src/engine/types.ts`); the caption
   stack dropped its Inter fallback.
6. Em/en dash sweep: zero remain in UI copy anywhere (toasts, menu labels,
   error strings) and in the comments of every file this redesign touched.

## Grep proofs

- `grep -ri '6f6bff' src index.html` returns 0 hits.
- `grep -ri "'Inter'" src index.html` returns 0 hits (all remaining `Inter`
  substrings in the tree are words like interface/internal/interpolate).
- No `Inter` or `#6f6bff` in `index.html`, `src/index.css`, `src/fonts.css`.

## Contrast (WCAG 2.1, computed from the tokens)

Text on the surface it actually sits on; AA body threshold is 4.5:1.

| Pair | Ratio | Verdict |
| --- | --- | --- |
| text-primary `#ede9e3` on app/panel/elevated/input | 15.95 / 15.35 / 14.38 / 13.26 | AAA |
| text-secondary `#a8a199` on app/panel/elevated/input | 7.55 / 7.27 / 6.81 / 6.28 | AA+ |
| text-muted `#8d877e` on app/panel/elevated/input | 5.42 / 5.21 / 4.89 / 4.50 | AA |
| accent-fg `#1a1420` on accent `#f0d7ff` (primary buttons) | 13.62 | AAA |
| danger `#ff6155` on panel | 6.27 | AA |
| ember `#ffa946` on panel | 9.73 | AAA |
| success `#4cc2a7` on panel | 8.47 | AAA |
| clip label text on video/audio/image/title fills | 7.70 / 7.42 / 7.40 / 6.48 | AA+ |
| playhead `#ff4d3d` on app (non-text, 3:1 target) | 5.86 | pass |

Zero AA failures; nothing needed fixing. Deep teal `#034f46` is fill-only by
design (documented in `src/index.css`); the text-safe teal is `#4cc2a7`.

## Screenshot index (all shot headless on port 5178, 1600x900)

| Surface | File |
| --- | --- |
| Full app | `_verify/pro/app/app.png` |
| Timeline (families, selection ring, playhead) | `_verify/pro/timeline/timeline.png` |
| Monitor + transform overlay | `_verify/pro/monitor/monitor-overlay.png` |
| Inspector, single clip | `_verify/pro/inspector-single/inspector-single.png` |
| Inspector, multi selection | `_verify/pro/inspector-multi/inspector-multi.png` |
| Left panel: Media | `_verify/pro/left-media/left-media.png` |
| Left panel: Effects | `_verify/pro/left-effects/left-effects.png` |
| Left panel: Library | `_verify/pro/left-library/left-library.png` |
| Export dialog | `_verify/pro/export-dialog/export-dialog.png` |
| Captions dialog | `_verify/pro/captions-dialog/captions-dialog.png` |
| Keyboard help | `_verify/pro/keyboard-help/keyboard-help.png` |
| Command palette | `_verify/pro/command-palette/command-palette.png` |
| Quick start (first run) | `_verify/pro/quick-start/quick-start.png` |
| Context menu (clip) | `_verify/pro/context-menu/context-menu.png` |
| Context submenu clamped at viewport bottom | `_verify/pro/context-menu/context-submenu.png` |
| Toast stack | `_verify/pro/toasts/toast.png` |

Reshoot with `node _verify/pro/shoot.mjs` against a dev server on 5178.

## Anti-generic review

Every screenshot was judged against "does this still look like a generic AI
dark dashboard?". Verdict: no, on all 16. The tells that used to give it away
(neutral gray + Inter + indigo) are gone; what identifies it now is the warm
ground, the lavender/ember/teal family, mono tabular numerics, and 1px
structure. Two review-pass defects were found and fixed before the final
shots: the quick-start card occluding the inspector captures (shot order), and
the off-viewport submenu (real bug, fix 2 above).

## Perf guard (spec section 4, measured 2026-07-20 on this machine)

From `src/engine/perfGuard.test.ts`, a 200-clip sequence (4 video tracks with
keyframes/effects/transitions/fades + 2 audio tracks + 12 markers):

- `resolveFrame`: 0.0046 to 0.0049 ms/call measured; budget 0.010 ms/call
- `collectSnapPoints`: 0.0115 to 0.0120 ms/call measured; budget 0.025 ms/call

Both budgets together are under 0.4 percent of a 16.7 ms frame. The test trips
if either hot path gets 2x slower.

## Final gate state

- `npx tsc --noEmit`: clean
- `eslint .`: clean
- `vitest run`: 57 files, 936/936 passed
- `vite build`: green (14.9s)
- Playwright e2e (port 5178, workers=1): 156/156 passed after the two
  integration fixes above (the initial run was 154/156; both failures traced
  to the mod+k conflict and the submenu clamp, not to weakened asserts)
