// The LUT bank: the colour tables the renderer can read, by id.
//
// WHY A BANK. `resolveFrame(seq, t)` takes only a Sequence, and the renderer runs
// in two places (the preview on the main thread, the export in a worker), so a LUT
// effect cannot carry its table through the frame it resolves to: that would copy
// megabytes into every frame of every clip. A resolved LUT effect carries only the
// table's ID, and each thread keeps a bank of decoded tables the renderer asks.
//   - The main thread fills its bank from `Project.luts` whenever the project
//     changes (state/lutSync.ts).
//   - The export worker is handed the tables its sequence uses in the `init`
//     message (export/messages.ts) and fills its own bank before it renders.
// Both read the same project, so both draw the same table.
//
// `Project.luts` is what travels with the project (saved, moved, reopened). The
// table sits there as base64 floats; the bank holds the decoded `ParsedCube`.
//
// Pure apart from the module level Map: no GL, no DOM, no store.

import type { Id, LutAsset, Sequence } from '../types'
import type { ParsedCube } from './cube'

const bank = new Map<Id, ParsedCube>()

/** The table with this id, if this thread has been given it. */
export const getLut = (id: Id | undefined): ParsedCube | undefined => (id === undefined ? undefined : bank.get(id))

/** Forget every table (tests, and a worker that is reused for another sequence). */
export function clearLutBank(): void {
  bank.clear()
}

// --- Bytes <-> base64 -------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(bin)
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// --- Identity ---------------------------------------------------------------

/**
 * A content hash of a table, as a short id. Two 32 bit mixes with different
 * seeds over the table's own numbers (its kind, size, domain and every float), so
 * the same file loaded twice is ONE entry in the project, and two different
 * tables do not share an id. It is an id for de-duplication, not a security hash.
 */
export function hashCube(cube: ParsedCube): string {
  let a = 0x811c9dc5
  let b = 0x9747b28c
  const mix = (word: number): void => {
    a = Math.imul(a ^ word, 0x01000193)
    b = Math.imul(b ^ (word + 0x9e3779b9), 0x85ebca6b)
    b ^= b >>> 15
  }
  const head = new Float32Array([cube.kind === '3d' ? 3 : 1, cube.size, ...cube.domainMin, ...cube.domainMax])
  const headWords = new Uint32Array(head.buffer)
  for (let i = 0; i < headWords.length; i++) mix(headWords[i])
  const words = new Uint32Array(cube.data.buffer, cube.data.byteOffset, cube.data.length)
  for (let i = 0; i < words.length; i++) mix(words[i])
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0')
  return `lut_${hex(a)}${hex(b)}`
}

// --- Project form <-> decoded form -----------------------------------------

/** A parsed table in the form a project carries it. `name` is what the Inspector shows. */
export function lutAssetFromCube(name: string, cube: ParsedCube): LutAsset {
  const bytes = new Uint8Array(cube.data.buffer, cube.data.byteOffset, cube.data.byteLength)
  return {
    id: hashCube(cube),
    name,
    kind: cube.kind,
    size: cube.size,
    domainMin: [...cube.domainMin],
    domainMax: [...cube.domainMax],
    data: bytesToBase64(bytes),
  }
}

/** How many rows of three floats a table of this kind and size holds. */
const rowsOf = (kind: '1d' | '3d', size: number): number => (kind === '3d' ? size ** 3 : size)

/** Three finite numbers each, and the top above the bottom: the shader divides by their difference. */
function validDomain(lo: unknown, hi: unknown): boolean {
  if (!Array.isArray(lo) || !Array.isArray(hi) || lo.length !== 3 || hi.length !== 3) return false
  for (let i = 0; i < 3; i++) {
    if (typeof lo[i] !== 'number' || typeof hi[i] !== 'number') return false
    if (!Number.isFinite(lo[i]) || !Number.isFinite(hi[i]) || !(hi[i] > lo[i])) return false
  }
  return true
}

/**
 * The decoded table of a stored LUT, or null when what is stored is damaged (a
 * project file edited by hand, a truncated save). Never throws: a LUT that cannot
 * be read draws nothing, and the picture passes through.
 */
export function cubeFromLutAsset(asset: LutAsset): ParsedCube | null {
  if (!asset || (asset.kind !== '1d' && asset.kind !== '3d')) return null
  if (!Number.isInteger(asset.size) || asset.size < 2) return null
  if (typeof asset.data !== 'string') return null
  if (!validDomain(asset.domainMin, asset.domainMax)) return null
  let bytes: Uint8Array
  try {
    bytes = base64ToBytes(asset.data)
  } catch {
    return null
  }
  const floats = rowsOf(asset.kind, asset.size) * 3
  if (bytes.length !== floats * 4) return null
  const data = new Float32Array(bytes.buffer, 0, floats)
  for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) return null
  return {
    kind: asset.kind,
    size: asset.size,
    domainMin: [...asset.domainMin],
    domainMax: [...asset.domainMax],
    title: asset.name,
    data,
  }
}

/** Decode and keep any of these tables this thread does not hold yet. */
export function registerLutAssets(assets: Readonly<Record<Id, LutAsset>> | readonly LutAsset[] | undefined): void {
  if (!assets) return
  const list: readonly LutAsset[] = Array.isArray(assets) ? assets : Object.values(assets)
  for (const asset of list) {
    if (!asset || bank.has(asset.id)) continue
    const cube = cubeFromLutAsset(asset)
    if (cube) bank.set(asset.id, cube)
  }
}

/** Keep a table already in hand (just parsed), under its id. */
export function registerCube(id: Id, cube: ParsedCube): void {
  bank.set(id, cube)
}

// --- Which tables a sequence needs -----------------------------------------

/** The ids of every table any effect on any clip of this sequence reads. */
export function lutIdsUsedBy(seq: Sequence): Set<Id> {
  const ids = new Set<Id>()
  for (const track of seq.tracks) {
    for (const clip of track.clips) {
      for (const fx of clip.effects) if (fx.lut !== undefined) ids.add(fx.lut)
    }
  }
  return ids
}

/** The stored tables this sequence uses, for the export worker's `init` message. */
export function lutsUsedBy(seq: Sequence, luts: Readonly<Record<Id, LutAsset>> | undefined): LutAsset[] {
  if (!luts) return []
  const out: LutAsset[] = []
  for (const id of lutIdsUsedBy(seq)) {
    const asset = luts[id]
    if (asset) out.push(asset)
  }
  return out
}
