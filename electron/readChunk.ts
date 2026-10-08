// One piece of a file main holds (a preview copy, a conversion, a media copy), for
// the page to read a chunk at a time.
//
// ⛔ ONE COPY, NOT TWO. Each reader used to fill a fresh Buffer and then slice its
// ArrayBuffer, "to copy out of the Buffer pool". Buffer.alloc never uses the pool:
// the Buffer owns its whole ArrayBuffer. So the slice was a second 8 MB copy on
// main's thread for every chunk, about 900 of them for a 7 GB media repair. A full
// chunk is now handed over as it is; only a short last chunk is trimmed.
//
// No `electron` import, so it is tested on its own.

import type { FileHandle } from 'node:fs/promises'

export async function readChunk(handle: FileHandle, offset: number, length: number): Promise<ArrayBuffer> {
  const buf = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buf, 0, length, offset)
  const whole = buf.buffer as ArrayBuffer
  // The Buffer is the whole of its ArrayBuffer and every byte of it was read: that
  // IS the answer, and nothing else can be sharing it.
  if (bytesRead === length && buf.byteOffset === 0 && whole.byteLength === length) return whole
  return whole.slice(buf.byteOffset, buf.byteOffset + bytesRead)
}
