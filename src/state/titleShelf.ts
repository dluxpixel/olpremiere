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

import type { AppearanceSpec, TitleDef } from '../engine/types'

export interface TitleLook {
  id: string
  name: string
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
]

export const titleLookById = (id: string): TitleLook | undefined => TITLE_SHELF.find((l) => l.id === id)
