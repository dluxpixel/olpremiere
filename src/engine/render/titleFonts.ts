// Bundled title fonts. The title rasterizer runs in TWO contexts — the main
// thread (live preview) and the export worker — and each has its OWN FontFaceSet
// (document.fonts vs self.fonts). A canvas font is only available once its
// FontFace is registered in THAT context's set, so both call loadTitleFonts with
// their own set. Registering in both is what keeps a custom-font title
// preview == export.
//
// The font file is bundled by Vite (?url) so the same emitted asset URL resolves
// in both the app bundle and the worker bundle.

import monocraftUrl from '../../assets/fonts/Monocraft.ttf?url'
import { clearTitleCache } from './titleRaster'

export interface CustomTitleFont {
  /** Shown in the Title font dropdown. */
  label: string
  /** The FontFace family name + what the CSS/canvas stack resolves to. */
  family: string
  /** The value stored in TitleDef.fontFamily (a full CSS font stack). */
  stack: string
  url: string
}

/** Minecraft-style pixel font (Monocraft, SIL OFL — safe to ship publicly). */
export const MONOCRAFT_STACK = "'Monocraft', 'Courier New', monospace"

export const CUSTOM_TITLE_FONTS: CustomTitleFont[] = [
  { label: 'Minecraft', family: 'Monocraft', stack: MONOCRAFT_STACK, url: monocraftUrl },
]

// One in-flight load per JS context (the main window, or a worker). Module state
// is per-context, so this dedupes within each without leaking across the worker
// boundary.
let loadPromise: Promise<void> | null = null

/**
 * Register + load every bundled title font into `fontset` (pass `document.fonts`
 * on the main thread, `self.fonts` in the worker). Idempotent per context. Never
 * throws — a font that fails to load just falls back to its CSS stack. Clears the
 * title raster cache afterwards so anything drawn with the fallback re-rasters.
 */
export function loadTitleFonts(fontset: FontFaceSet): Promise<void> {
  loadPromise ??= (async () => {
    await Promise.all(
      CUSTOM_TITLE_FONTS.map(async (f) => {
        try {
          // A weight range maps a bold (700) request onto this single file, so
          // there is no faux-bold synthesis that could differ between the two
          // rendering contexts.
          const face = new FontFace(f.family, `url(${f.url})`, { weight: '1 1000' })
          await face.load()
          fontset.add(face)
        } catch (err) {
          console.error(`OL Studio: failed to load title font "${f.label}"`, err)
        }
      }),
    )
    clearTitleCache()
  })()
  return loadPromise
}
