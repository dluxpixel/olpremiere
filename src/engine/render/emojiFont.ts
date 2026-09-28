// Apple emoji in titles and captions. His ask, 2026-09-28: *"make it so when
// I play, paste in emojis, it's the Apple emojis."*
//
// The face (fetched onto his computer by electron/emojiFont.ts, never shipped
// in the app) goes FIRST in every title's font string, and is registered with an emoji only
// unicode-range. So for each character the browser asks it first, and it only
// answers for an emoji: letters, digits and punctuation skip it and draw in the
// title's own font exactly as before (their widths are unchanged, measured).
//
// Its own module, with no imports, because both titleRaster.ts (the font
// string) and titleFonts.ts (the loading) need it and those two import each
// other's other half.

/** The family the Apple emoji face is registered under, in the page and the export worker. */
export const EMOJI_FAMILY = 'OLP Apple Emoji'

/** Put in front of a title's own stack: `'OLP Apple Emoji', 'TikTok Sans', ...`. */
export const EMOJI_STACK = `'${EMOJI_FAMILY}'`

/**
 * The characters the face answers for. Emoji blocks, plus the joiners that hold
 * a sequence together (ZWJ, the emoji variation selector, the keycap mark, the
 * flag tags), so a combined emoji is shaped in one font and not split across
 * two. NOT the digits, # or *: those are keycap bases, and taking them would
 * swap every number in his captions into the emoji font. Nor © ® ™, which read
 * as text in a caption.
 */
export const EMOJI_UNICODE_RANGE = [
  'U+203C',
  'U+2049',
  'U+2139',
  'U+2194-21AA',
  'U+231A-23FF',
  'U+24C2',
  'U+25AA-25FE',
  'U+2600-27BF',
  'U+2934-2935',
  'U+2B05-2B55',
  'U+3030',
  'U+303D',
  'U+3297',
  'U+3299',
  'U+FE0F',
  'U+200D',
  'U+20E3',
  'U+1F000-1FAFF',
  'U+E0020-E007F',
].join(', ')

/**
 * Where the face is fetched from: the desktop app's own app:// origin, which
 * fetches it onto his computer the first time (electron/emojiFont.ts). Relative,
 * so it resolves the same in the page and in the export worker.
 */
export const EMOJI_FONT_URL = '/user-fonts/apple-emoji.ttf'

/**
 * Only the desktop app has the face. The web build and the dev server have no
 * app:// origin to fetch it from, so there emoji stay the system's own (on his
 * iPhone, that already IS Apple's).
 */
export const emojiFontAvailable = (): boolean =>
  typeof location !== 'undefined' && location.protocol === 'app:'

const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u

/** Does this text hold an emoji, so the Apple face has to be loaded before it is drawn? */
export const hasEmoji = (text: string | undefined): boolean => !!text && EMOJI_RE.test(text)

/**
 * Can the fetched face put a skin tone, a family, a flag or a keycap together?
 *
 * ⛔ NOT THE COPY IT FETCHES TODAY. That file joins those sequences with Apple's
 * own shaping table (morx), which Chromium does not read, so a thumbs up with a
 * skin tone would come out as a yellow thumb next to a brown square. The Windows
 * build of the same copy carries the table Chromium does read (GSUB); he was
 * asked on 2026-09-28 whether to fetch that one instead. Until then a title with
 * such a sequence keeps the system's own emoji, which do put them together, so
 * nothing he had before comes out worse. Flip this with the source in
 * electron/emojiFont.ts.
 */
export const EMOJI_FACE_JOINS_SEQUENCES = false

const JOINED_RE = /‍|⃣|[\u{1F3FB}-\u{1F3FF}]|\p{Regional_Indicator}|[\u{E0020}-\u{E007F}]/u

/** Should this text draw its emoji with the Apple face? */
export const appleEmojiFor = (text: string | undefined): boolean =>
  EMOJI_FACE_JOINS_SEQUENCES || !text || !JOINED_RE.test(text)
