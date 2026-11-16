// Ready made titles: pick one and it lands on the timeline, styled and moving.
//
// Premiere's Essential Graphics shelf is the one thing its users say they miss
// after switching, "pre-built mographs that I could just throw onto my project"
// (community research, 2026-09-15). This is that idea at the size of this app:
// a handful of looks that each carry a style, an entrance and an exit, and a
// starting text, built on the same title clip and appearance keyframes every
// other title uses. Nothing new to render; a title from here is a title.
//
// Sizes are sequence pixels on the 1080 x 1920 short he edits, the same ladder
// the Inspector uses (types.ts withTitleFontSize). Outlines, boxes and shadows
// are the absolute pixels that ladder expects at those sizes.

import { tiktokLineBox } from '../engine/render/lineBox'
import { TIKTOK_SANS_STACK } from '../engine/render/titleFonts'
import type { AppearanceSpec, TitleDef } from '../engine/types'

export interface TitleLook {
  id: string
  name: string
  /** Looks that belong together share a group, so the shelf can show them in one block. Absent: ungrouped. */
  group?: string
  /** One line for the tooltip: where it sits and how it moves. */
  hint: string
  /** The text it arrives with, to be replaced. */
  text: string
  durationS: number
  style: Partial<TitleDef>
  appearance: AppearanceSpec
}

const WHITE = '#ffffff'
const INK = '#000000'

/**
 * What the four TikTok looks share. The shelf merges a look over defaultTitleDef,
 * which has a drop shadow, so each of the four says what it has and clears the
 * rest here. 64 px is TikTok's starting size on 1080 wide, on the ladder the
 * other looks use; the pinned weight of TikTok Sans is what `bold` reaches.
 */
const TIKTOK_BASE: Partial<TitleDef> = {
  fontFamily: TIKTOK_SANS_STACK,
  fontSizePx: 64,
  bold: true,
  align: 'center',
  vAlign: 'middle',
  shadow: undefined,
  outline: undefined,
  textCase: undefined,
}
const TIKTOK_APPEARANCE: AppearanceSpec = { in: 'fadeIn', out: 'fadeOut', durS: 0.12 }

export const TITLE_SHELF: readonly TitleLook[] = [
  {
    id: 'headline-pop',
    name: 'Headline pop',
    hint: 'Big, centred, pops in and out. For the one line the whole clip is about.',
    text: 'Your headline',
    durationS: 3,
    style: { fontSizePx: 120, color: WHITE, outline: { color: INK, widthPx: 16 }, align: 'center', vAlign: 'middle', textCase: 'upper' },
    appearance: { in: 'pop', out: 'popOut', durS: 0.16 },
  },
  {
    id: 'yellow-punch',
    name: 'Yellow punch',
    hint: 'The yellow hit, centred, pops. For a number or a single word.',
    text: 'BIG MOMENT',
    durationS: 2,
    style: { fontSizePx: 136, color: '#FFD400', outline: { color: INK, widthPx: 16 }, align: 'center', vAlign: 'middle', textCase: 'upper' },
    appearance: { in: 'pop', out: 'popOut', durS: 0.16 },
  },
  {
    id: 'lower-third',
    name: 'Lower third',
    hint: 'A name on a dark bar, bottom left, slides in and out.',
    text: 'Name',
    durationS: 4,
    style: {
      fontSizePx: 56,
      color: WHITE,
      align: 'left',
      vAlign: 'bottom',
      offsetXPx: 72,
      offsetYPx: -220,
      box: { color: 'rgba(0,0,0,0.72)', paddingPx: 22, radiusPx: 10 },
      shadow: undefined,
      textCase: undefined,
      bold: true,
    },
    appearance: { in: 'slideIn', out: 'slideOut', durS: 0.28 },
  },
  {
    id: 'caption-bar',
    name: 'Caption bar',
    hint: 'A sentence on a dark bar near the bottom, fades in and out.',
    text: 'Say it here',
    durationS: 4,
    style: {
      fontSizePx: 64,
      color: WHITE,
      align: 'center',
      vAlign: 'bottom',
      offsetYPx: -260,
      box: { color: 'rgba(0,0,0,0.7)', paddingPx: 24, radiusPx: 12 },
      shadow: undefined,
      textCase: undefined,
      bold: true,
    },
    appearance: { in: 'fadeIn', out: 'fadeOut', durS: 0.18 },
  },
  {
    id: 'quiet-subtitle',
    name: 'Quiet subtitle',
    hint: 'Small, plain, near the bottom, with just a shadow. For a note that should not shout.',
    text: 'A quiet note',
    durationS: 4,
    style: {
      fontSizePx: 44,
      color: WHITE,
      align: 'center',
      vAlign: 'bottom',
      offsetYPx: -300,
      bold: false,
      textCase: undefined,
      shadow: { color: 'rgba(0,0,0,0.8)', blurPx: 10, dx: 0, dy: 3 },
    },
    appearance: { in: 'fadeIn', out: 'fadeOut', durS: 0.25 },
  },
  {
    id: 'chapter-card',
    name: 'Chapter card',
    hint: 'Up top, in capitals, rises in and drops out. For a section change.',
    text: 'PART ONE',
    durationS: 3,
    style: { fontSizePx: 88, color: WHITE, outline: { color: INK, widthPx: 10 }, align: 'center', vAlign: 'top', offsetYPx: 220, textCase: 'upper' },
    appearance: { in: 'riseUp', out: 'dropDown', durS: 0.3 },
  },
  // The text TikTok's own app adds (his ask): its caption face, bold, centred, at
  // the size TikTok text starts at on a 1080 wide frame. The two highlight looks
  // read their box from the one TIKTOK_LINE_BOX block (render/lineBox.ts), so a
  // later measurement against a recording changes one place.
  {
    id: 'tiktok-plain',
    name: 'TikTok',
    group: 'tiktok',
    hint: 'White text with a soft dark shadow, the way TikTok adds it. Centred, fades in and out.',
    text: 'Type your text',
    durationS: 3,
    style: { ...TIKTOK_BASE, color: WHITE, shadow: { color: 'rgba(0,0,0,0.5)', blurPx: 8, dx: 0, dy: 2 } },
    appearance: TIKTOK_APPEARANCE,
  },
  {
    id: 'tiktok-outline',
    name: 'TikTok outline',
    group: 'tiktok',
    hint: 'White text with a black outline, the way TikTok adds it. Centred, fades in and out.',
    text: 'Type your text',
    durationS: 3,
    style: { ...TIKTOK_BASE, color: WHITE, outline: { color: INK, widthPx: 8 } },
    appearance: TIKTOK_APPEARANCE,
  },
  {
    id: 'tiktok-highlight',
    name: 'TikTok highlight',
    group: 'tiktok',
    hint: 'Black text on a white highlight that hugs every line, the way TikTok adds it. Centred, fades in and out.',
    text: 'Type your text',
    durationS: 3,
    style: { ...TIKTOK_BASE, color: INK, lineBox: tiktokLineBox(WHITE, 1) },
    appearance: TIKTOK_APPEARANCE,
  },
  {
    id: 'tiktok-soft',
    name: 'TikTok soft',
    group: 'tiktok',
    hint: 'White text on a see-through black highlight that hugs every line, the way TikTok adds it. Centred, fades in and out.',
    text: 'Type your text',
    durationS: 3,
    style: { ...TIKTOK_BASE, color: WHITE, lineBox: tiktokLineBox(INK, 0.5) },
    appearance: TIKTOK_APPEARANCE,
  },
]

export const titleLookById = (id: string): TitleLook | undefined => TITLE_SHELF.find((l) => l.id === id)

/** The looks of one group, in shelf order. */
export const titleLooksInGroup = (group: string): TitleLook[] => TITLE_SHELF.filter((l) => l.group === group)
