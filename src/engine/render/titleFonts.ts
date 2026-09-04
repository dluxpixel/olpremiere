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
import luckiestGuyUrl from '../../assets/fonts/LuckiestGuy-Regular.ttf?url'
import alfaSlabOneUrl from '../../assets/fonts/AlfaSlabOne-400.ttf?url'
import antonUrl from '../../assets/fonts/Anton-400.ttf?url'
import archivoBlackUrl from '../../assets/fonts/ArchivoBlack-400.ttf?url'
import bangersUrl from '../../assets/fonts/Bangers-400.ttf?url'
import barlowCondensedUrl from '../../assets/fonts/BarlowCondensed-900.ttf?url'
import bebasNeueUrl from '../../assets/fonts/BebasNeue-400.ttf?url'
import bowlbyOneUrl from '../../assets/fonts/BowlbyOne-400.ttf?url'
import bricolageGrotesqueUrl from '../../assets/fonts/BricolageGrotesque-800.ttf?url'
import bungeeUrl from '../../assets/fonts/Bungee-400.ttf?url'
import dMSansUrl from '../../assets/fonts/DMSans-900.ttf?url'
import fjallaOneUrl from '../../assets/fonts/FjallaOne-400.ttf?url'
import instrumentSerifUrl from '../../assets/fonts/InstrumentSerif-400.ttf?url'
import interUrl from '../../assets/fonts/Inter-900.ttf?url'
import kanitUrl from '../../assets/fonts/Kanit-900.ttf?url'
import leagueSpartanUrl from '../../assets/fonts/LeagueSpartan-900.ttf?url'
import manropeUrl from '../../assets/fonts/Manrope-800.ttf?url'
import oswaldUrl from '../../assets/fonts/Oswald-700.ttf?url'
import outfitUrl from '../../assets/fonts/Outfit-900.ttf?url'
import passionOneUrl from '../../assets/fonts/PassionOne-900.ttf?url'
import permanentMarkerUrl from '../../assets/fonts/PermanentMarker-400.ttf?url'
import playfairDisplayUrl from '../../assets/fonts/PlayfairDisplay-900.ttf?url'
import poppinsUrl from '../../assets/fonts/Poppins-900.ttf?url'
import righteousUrl from '../../assets/fonts/Righteous-400.ttf?url'
import robotoCondensedUrl from '../../assets/fonts/RobotoCondensed-900.ttf?url'
import rubikUrl from '../../assets/fonts/Rubik-900.ttf?url'
import shrikhandUrl from '../../assets/fonts/Shrikhand-400.ttf?url'
import soraUrl from '../../assets/fonts/Sora-800.ttf?url'
import spaceGroteskUrl from '../../assets/fonts/SpaceGrotesk-700.ttf?url'
import syneUrl from '../../assets/fonts/Syne-800.ttf?url'
import tekoUrl from '../../assets/fonts/Teko-700.ttf?url'
import titanOneUrl from '../../assets/fonts/TitanOne-400.ttf?url'
import ultraUrl from '../../assets/fonts/Ultra-400.ttf?url'
import workSansUrl from '../../assets/fonts/WorkSans-900.ttf?url'
import monocraftUrl from '../../assets/fonts/Monocraft.ttf?url'
import montserratUrl from '../../assets/fonts/Montserrat-Variable.ttf?url'
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
  /**
   * The weight range this FontFace DECLARES. Default '1 1000' lets one file
   * answer every weight request. A variable font can instead be pinned to one
   * weight (e.g. '800 800'), which is how the caption face always draws
   * ExtraBold: canvas can only ask for normal or bold, so the pin is the only
   * way to reach 800, and it renders the same in preview and in the export
   * worker because both register this exact descriptor.
   */
  weight?: string
  /**
   * Which shelf it sits on in the picker. Thirty-eight names in one flat list is
   * not a choice, it is a scroll, so the picker groups them by the job they do.
   * Undefined for the five that predate the library and are listed first.
   */
  group?: 'impact' | 'clean' | 'fun' | 'editorial'
}

/** Minecraft-style pixel font (Monocraft, SIL OFL, so safe to ship publicly). */
export const MONOCRAFT_STACK = "'Monocraft', 'Courier New', monospace"

/**
 * The caption face. Measured off the reference channel on 2026-07-29 rather than
 * guessed: a heavy UPRIGHT GEOMETRIC SANS of normal width, not a comic face and
 * not condensed. That is Montserrat (SIL OFL), shipped as the variable file and
 * pinned to ExtraBold below. It also covers every Czech diacritic, which the old
 * comic face did not.
 */
export const CAPTION_FONT_STACK = "'Montserrat', 'Arial Black', sans-serif"

/**
 * The comic display face (Lilita One, SIL OFL), the clean-licensed stand-in for
 * Obelix Pro. It WAS the caption default, on the assumption that the genre used
 * a comic face; the measurement said otherwise. Kept as a normal font choice
 * because saved projects store this stack by value inside every title.
 */
export const COMIC_STACK = "'Lilita One', 'Arial Black', sans-serif"

/**
 * Versatile Bold (OnlineWebFonts.com, CC BY 4.0, credited in
 * VersatileBold-License.txt). A heavy display face for punchy titles. The
 * FontFace API keys off the family name we DECLARE below, so this string is the
 * single source of truth, and it need not match the file's internal name.
 */
export const VERSATILE_STACK = "'Versatile Bold', 'Arial Black', sans-serif"

/**
 * Luckiest Guy (Astigmatic, SIL OFL, licence in LuckiestGuy-OFL.txt), his ask
 * 2026-08-24. The fat cartoon caps face that half of YouTube and every gaming
 * Short is titled in, and the closest thing in the list to what a thumbnail
 * wants. It is CAPS ONLY by design: lowercase letters in the file are drawn as
 * capitals, so a title typed in lower case still comes out shouting. That is the
 * font, not a bug, and it is why the fallback is 'Arial Black' rather than a
 * mixed-case face that would change shape completely if the file ever failed.
 */
export const LUCKIEST_GUY_STACK = "'Luckiest Guy', 'Arial Black', sans-serif"

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
  {
    label: 'Caption Bold',
    family: 'Montserrat',
    stack: CAPTION_FONT_STACK,
    url: montserratUrl,
    // Pinned: this face exists for captions, and captions are always ExtraBold.
    weight: '800 800',
  },
  { label: 'Comic Bold', family: 'Lilita One', stack: COMIC_STACK, url: lilitaUrl },
  { label: 'Versatile Bold', family: 'Versatile Bold', stack: VERSATILE_STACK, url: versatileUrl },
  { label: 'Luckiest Guy', family: 'Luckiest Guy', stack: LUCKIEST_GUY_STACK, url: luckiestGuyUrl },
  { label: 'Alfa Slab One', family: 'Alfa Slab One', stack: "'Alfa Slab One', 'Comic Sans MS', cursive", url: alfaSlabOneUrl, weight: '400 400', group: 'fun' },
  { label: 'Anton', family: 'Anton', stack: "'Anton', 'Arial Black', sans-serif", url: antonUrl, weight: '400 400', group: 'impact' },
  { label: 'Archivo Black', family: 'Archivo Black', stack: "'Archivo Black', 'Arial Black', sans-serif", url: archivoBlackUrl, weight: '400 400', group: 'impact' },
  { label: 'Bangers', family: 'Bangers', stack: "'Bangers', 'Comic Sans MS', cursive", url: bangersUrl, weight: '400 400', group: 'fun' },
  { label: 'Barlow Condensed', family: 'Barlow Condensed', stack: "'Barlow Condensed', 'Arial Black', sans-serif", url: barlowCondensedUrl, weight: '900 900', group: 'impact' },
  { label: 'Bebas Neue', family: 'Bebas Neue', stack: "'Bebas Neue', 'Arial Black', sans-serif", url: bebasNeueUrl, weight: '400 400', group: 'impact' },
  { label: 'Bowlby One', family: 'Bowlby One', stack: "'Bowlby One', 'Arial Black', sans-serif", url: bowlbyOneUrl, weight: '400 400', group: 'impact' },
  { label: 'Bricolage Grotesque', family: 'Bricolage Grotesque', stack: "'Bricolage Grotesque', Georgia, serif", url: bricolageGrotesqueUrl, weight: '800 800', group: 'editorial' },
  { label: 'Bungee', family: 'Bungee', stack: "'Bungee', 'Comic Sans MS', cursive", url: bungeeUrl, weight: '400 400', group: 'fun' },
  { label: 'DMSans', family: 'DMSans', stack: "'DMSans', system-ui, sans-serif", url: dMSansUrl, weight: '900 900', group: 'clean' },
  { label: 'Fjalla One', family: 'Fjalla One', stack: "'Fjalla One', 'Arial Black', sans-serif", url: fjallaOneUrl, weight: '400 400', group: 'impact' },
  { label: 'Instrument Serif', family: 'Instrument Serif', stack: "'Instrument Serif', Georgia, serif", url: instrumentSerifUrl, weight: '400 400', group: 'editorial' },
  { label: 'Inter', family: 'Inter', stack: "'Inter', system-ui, sans-serif", url: interUrl, weight: '900 900', group: 'clean' },
  { label: 'Kanit', family: 'Kanit', stack: "'Kanit', 'Comic Sans MS', cursive", url: kanitUrl, weight: '900 900', group: 'fun' },
  { label: 'League Spartan', family: 'League Spartan', stack: "'League Spartan', system-ui, sans-serif", url: leagueSpartanUrl, weight: '900 900', group: 'clean' },
  { label: 'Manrope', family: 'Manrope', stack: "'Manrope', system-ui, sans-serif", url: manropeUrl, weight: '800 800', group: 'clean' },
  { label: 'Oswald', family: 'Oswald', stack: "'Oswald', 'Arial Black', sans-serif", url: oswaldUrl, weight: '700 700', group: 'impact' },
  { label: 'Outfit', family: 'Outfit', stack: "'Outfit', system-ui, sans-serif", url: outfitUrl, weight: '900 900', group: 'clean' },
  { label: 'Passion One', family: 'Passion One', stack: "'Passion One', 'Arial Black', sans-serif", url: passionOneUrl, weight: '900 900', group: 'impact' },
  { label: 'Permanent Marker', family: 'Permanent Marker', stack: "'Permanent Marker', 'Comic Sans MS', cursive", url: permanentMarkerUrl, weight: '400 400', group: 'fun' },
  { label: 'Playfair Display', family: 'Playfair Display', stack: "'Playfair Display', Georgia, serif", url: playfairDisplayUrl, weight: '900 900', group: 'editorial' },
  { label: 'Poppins', family: 'Poppins', stack: "'Poppins', system-ui, sans-serif", url: poppinsUrl, weight: '900 900', group: 'clean' },
  { label: 'Righteous', family: 'Righteous', stack: "'Righteous', 'Comic Sans MS', cursive", url: righteousUrl, weight: '400 400', group: 'fun' },
  { label: 'Roboto Condensed', family: 'Roboto Condensed', stack: "'Roboto Condensed', 'Arial Black', sans-serif", url: robotoCondensedUrl, weight: '900 900', group: 'impact' },
  { label: 'Rubik', family: 'Rubik', stack: "'Rubik', system-ui, sans-serif", url: rubikUrl, weight: '900 900', group: 'clean' },
  { label: 'Shrikhand', family: 'Shrikhand', stack: "'Shrikhand', 'Comic Sans MS', cursive", url: shrikhandUrl, weight: '400 400', group: 'fun' },
  { label: 'Sora', family: 'Sora', stack: "'Sora', system-ui, sans-serif", url: soraUrl, weight: '800 800', group: 'clean' },
  { label: 'Space Grotesk', family: 'Space Grotesk', stack: "'Space Grotesk', system-ui, sans-serif", url: spaceGroteskUrl, weight: '700 700', group: 'clean' },
  { label: 'Syne', family: 'Syne', stack: "'Syne', Georgia, serif", url: syneUrl, weight: '800 800', group: 'editorial' },
  { label: 'Teko', family: 'Teko', stack: "'Teko', 'Arial Black', sans-serif", url: tekoUrl, weight: '700 700', group: 'impact' },
  { label: 'Titan One', family: 'Titan One', stack: "'Titan One', 'Comic Sans MS', cursive", url: titanOneUrl, weight: '400 400', group: 'fun' },
  { label: 'Ultra', family: 'Ultra', stack: "'Ultra', 'Arial Black', sans-serif", url: ultraUrl, weight: '400 400', group: 'impact' },
  { label: 'Work Sans', family: 'Work Sans', stack: "'Work Sans', system-ui, sans-serif", url: workSansUrl, weight: '900 900', group: 'clean' },
]

/**
 * The shelf headings, in the order they appear.
 *
 * Named for the JOB, not for the classification. "Impact" is what he is looking
 * for when he wants a word across the middle of a Short; "Grotesque, condensed,
 * heavy" is what a type specimen would call it and is no help at all at the
 * moment of choosing.
 */
export const GROUP_LABEL = {
  core: 'Yours',
  impact: 'Impact and captions',
  clean: 'Clean sans',
  fun: 'Display and fun',
  editorial: 'Editorial',
  system: 'System',
} as const

/** Every selectable title font (bundled + system stacks), for the Inspector
 * dropdown AND the right-click Font menu: one shared source of truth. Figtree
 * leads because it is the default face for new titles. */
export const TITLE_FONT_OPTIONS: { label: string; value: string; group: string }[] = [
  { label: 'Figtree', value: FIGTREE_TITLE_STACK, group: GROUP_LABEL.core },
  { label: 'Minecraft', value: MONOCRAFT_STACK, group: GROUP_LABEL.core },
  { label: 'Caption Bold', value: CAPTION_FONT_STACK, group: GROUP_LABEL.core },
  { label: 'Comic Bold', value: COMIC_STACK, group: GROUP_LABEL.core },
  { label: 'Versatile Bold', value: VERSATILE_STACK, group: GROUP_LABEL.core },
  { label: 'Luckiest Guy', value: LUCKIEST_GUY_STACK, group: GROUP_LABEL.core },
  ...(['impact', 'clean', 'fun', 'editorial'] as const).flatMap((g) =>
    CUSTOM_TITLE_FONTS.filter((f) => f.group === g).map((f) => ({
      label: f.label,
      value: f.stack,
      group: GROUP_LABEL[g],
    })),
  ),
  // The system stacks last: they are always available and never need loading,
  // but they are also not what anybody reaches for.
  { label: 'Georgia', value: 'Georgia, serif', group: GROUP_LABEL.system },
  { label: 'Courier', value: "'Courier New', monospace", group: GROUP_LABEL.system },
  { label: 'Arial', value: 'Arial, sans-serif', group: GROUP_LABEL.system },
]

/**
 * ⛔ THE FACES LOADED BEFORE HE HAS ASKED FOR ANYTHING, 2026-08-31.
 *
 * Until the library went from five fonts to thirty-eight, "load them all at
 * boot" was fine. It is not fine now: it is thirty-eight concurrent fetches and
 * decodes in front of an editor he is waiting to use, which is the same
 * everything-at-once shape that was taken out of the audio path all last week.
 *
 * So only these load eagerly, and they are the ones a project can already be
 * using before he touches the font picker: the default face for a new title, the
 * caption face, and the three that shipped before the library existed and are
 * therefore stored by value inside saved projects.
 */
const CORE_FAMILIES: readonly string[] = [
  'Figtree Variable',
  'Montserrat',
  'Monocraft',
  'Lilita One',
  'Versatile Bold',
]

/**
 * One in-flight load per FAMILY per JS context (the main window, or a worker).
 * Module state is per-context, so this dedupes within each without leaking across
 * the worker boundary.
 */
const inFlight = new Map<string, Promise<void>>()

function loadOne(fontset: FontFaceSet, f: CustomTitleFont): Promise<void> {
  const started = inFlight.get(f.family)
  if (started) return started
  const p = (async () => {
    try {
      // A weight range maps a bold (700) request onto this single file, so there
      // is no faux-bold synthesis that could differ between the two rendering
      // contexts. A font may pin its own range (see `weight`).
      const face = new FontFace(f.family, `url(${f.url})`, { weight: f.weight ?? '1 1000' })
      await face.load()
      fontset.add(face)
    } catch (err) {
      console.error(`OL Premiere: failed to load title font "${f.label}"`, err)
    }
  })()
  inFlight.set(f.family, p)
  return p
}

/**
 * Every `fontFamily` a sequence's titles actually ask for.
 *
 * ⛔ THIS IS WHAT THE EXPORT WORKER LOADS, AND WHY IT CAN. The worker has no font
 * picker and cannot know what he chose, and since the library went to
 * thirty-eight faces it can no longer just load them all. So the families are
 * read off the document itself, which is the only source that is true in both
 * contexts.
 */
export function titleFontStacksIn(seq: {
  tracks: readonly { clips: readonly { title?: { fontFamily?: string } }[] }[]
}): string[] {
  const out = new Set<string>()
  for (const t of seq.tracks) {
    for (const c of t.clips) {
      const f = c.title?.fontFamily
      if (f) out.add(f)
    }
  }
  return [...out]
}

/** The registry row for a stored `fontFamily` stack, or undefined for a system stack. */
export const bundledFontForStack = (stack: string): CustomTitleFont | undefined =>
  CUSTOM_TITLE_FONTS.find((f) => f.stack === stack)

/**
 * Make sure one family is registered in this context, and re-raster once it is.
 *
 * ⛔ THE CACHE CLEAR IS WHY THIS IS NOT JUST `loadOne`. A title drawn before its
 * face arrived was rasterised in the fallback, and that raster is cached: without
 * the clear it keeps the wrong shapes until something else invalidates it.
 */
export async function ensureTitleFont(fontset: FontFaceSet, stack: string): Promise<void> {
  const f = bundledFontForStack(stack)
  if (!f || inFlight.has(f.family)) return
  await loadOne(fontset, f)
  clearTitleCache()
}

/**
 * Register + load the title fonts into `fontset` (pass `document.fonts` on the
 * main thread, `self.fonts` in the worker). Idempotent per context. Never throws:
 * a font that fails to load just falls back to its CSS stack. Clears the title
 * raster cache afterwards so anything drawn with the fallback re-rasters.
 *
 * ⚠️ `stacks` IS HOW THE EXPORT STAYS EQUAL TO THE PREVIEW. The worker has no
 * font picker and no idea what he chose, so the caller hands it every
 * `fontFamily` the sequence actually uses. Omit it and only the core faces load,
 * which is right for boot and wrong for an export.
 */
export function loadTitleFonts(fontset: FontFaceSet, stacks?: readonly string[]): Promise<void> {
  const wanted = new Set(CORE_FAMILIES)
  for (const s of stacks ?? []) {
    const f = bundledFontForStack(s)
    if (f) wanted.add(f.family)
  }
  const rows = CUSTOM_TITLE_FONTS.filter((f) => wanted.has(f.family))
  return Promise.all(rows.map((f) => loadOne(fontset, f))).then(() => clearTitleCache())
}
