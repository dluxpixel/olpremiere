// Bundled title fonts. The title rasterizer runs in TWO contexts: the main
// thread (live preview) and the export worker. Each has its OWN FontFaceSet
// (document.fonts vs self.fonts). A canvas font is only available once its
// FontFace is registered in THAT context's set, so both call loadTitleFonts with
// their own set. Registering in both is what keeps a custom-font title
// preview == export.
//
// The font file is bundled by Vite (?url) so the same emitted asset URL resolves
// in both the app bundle and the worker bundle.

import lilitaUrl from '../../assets/fonts/LilitaOne-Regular.ttf?url'
import monocraftUrl from '../../assets/fonts/Monocraft.ttf?url'
import versatileUrl from '../../assets/fonts/VersatileBold.ttf?url'
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

/** Minecraft-style pixel font (Monocraft, SIL OFL, so safe to ship publicly). */
export const MONOCRAFT_STACK = "'Monocraft', 'Courier New', monospace"

/**
 * The Shorts-caption comic face (Lilita One, SIL OFL). The genre's exact font
 * (Obelix Pro) has an unclear commercial license, so we ship the standard
 * clean-licensed lookalike; the caption style defaults to this stack.
 */
export const CAPTION_FONT_STACK = "'Lilita One', 'Arial Black', sans-serif"

/**
 * Versatile Bold (OnlineWebFonts.com, CC BY 4.0, credited in
 * VersatileBold-License.txt). A heavy display face for punchy titles. The
 * FontFace API keys off the family name we DECLARE below, so this string is the
 * single source of truth, and it need not match the file's internal name.
 */
export const VERSATILE_STACK = "'Versatile Bold', 'Arial Black', sans-serif"

/**
 * Figtree (the UI family) doubling as the default title face. Served from the
 * same self-hosted woff2 the UI loads (public/fonts), and registered in the
 * export worker's own FontFaceSet so titled text matches preview == export.
 * Latin subset only; other scripts fall back down the stack.
 */
export const FIGTREE_TITLE_STACK = "'Figtree Variable', 'Segoe UI', system-ui, sans-serif"

// To add another bundled font: (1) drop the .ttf in src/assets/fonts/, (2) add
// an `import <name>Url from '../../assets/fonts/<File>.ttf?url'` up top, (3) add
// one row here. It flows into the dropdown + loader automatically.
export const CUSTOM_TITLE_FONTS: CustomTitleFont[] = [
  {
    label: 'Figtree',
    family: 'Figtree Variable',
    stack: FIGTREE_TITLE_STACK,
    url: '/fonts/figtree-latin-wght-normal.woff2',
  },
  { label: 'Minecraft', family: 'Monocraft', stack: MONOCRAFT_STACK, url: monocraftUrl },
  { label: 'Comic Bold (captions)', family: 'Lilita One', stack: CAPTION_FONT_STACK, url: lilitaUrl },
  { label: 'Versatile Bold', family: 'Versatile Bold', stack: VERSATILE_STACK, url: versatileUrl },
]

/** Every selectable title font (bundled + system stacks), for the Inspector
 * dropdown AND the right-click Font menu: one shared source of truth. Figtree
 * leads because it is the default face for new titles. */
export const TITLE_FONT_OPTIONS: { label: string; value: string }[] = [
  { label: 'Figtree', value: FIGTREE_TITLE_STACK },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Courier', value: "'Courier New', monospace" },
  { label: 'Arial', value: 'Arial, sans-serif' },
  ...CUSTOM_TITLE_FONTS.filter((f) => f.stack !== FIGTREE_TITLE_STACK).map((f) => ({
    label: f.label,
    value: f.stack,
  })),
]

// One in-flight load per JS context (the main window, or a worker). Module state
// is per-context, so this dedupes within each without leaking across the worker
// boundary.
let loadPromise: Promise<void> | null = null

/**
 * Register + load every bundled title font into `fontset` (pass `document.fonts`
 * on the main thread, `self.fonts` in the worker). Idempotent per context. Never
 * throws: a font that fails to load just falls back to its CSS stack. Clears the
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
