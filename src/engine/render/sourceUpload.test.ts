// How many times the renderer uploads a CHANGING source (a video frame) in one
// frame. PB-5, 2026-10-06: a clip over its own blurred background is two layers
// of one picture, and it was uploaded twice per frame with two mip chains.
// There is no GPU under vitest, so this counts the calls a stand-in WebGL2
// context receives, the same way exportDither.test.ts does.

import { describe, expect, it } from 'vitest'
import { createRenderer } from './glRenderer'
import { defaultTransform } from '../types'
import type { RenderFrame, RenderLayer } from './types'

/** A WebGL2 context that draws nothing and counts picture uploads, and the ones that allocate. */
function countingGl(): { gl: WebGL2RenderingContext; uploads: () => number; allocs: () => number } {
  let uploads = 0
  let allocs = 0
  const consts = new Map<string, number>([['FRAMEBUFFER_COMPLETE', 0x8cd5]])
  let next = 0x10000
  const impl: Record<string, unknown> = {
    canvas: { width: 320, height: 180 },
    getExtension: () => null,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getAttribLocation: () => 0,
    getUniformLocation: () => ({}),
    checkFramebufferStatus: () => 0x8cd5,
    isContextLost: () => false,
    // (target, level, internalformat, format, type, source) is a picture; the
    // nine argument form allocates an empty buffer.
    // Either form gives the texture new storage, which texSubImage2D never does.
    texImage2D: (...args: unknown[]) => {
      allocs++
      if (args.length !== 9) uploads++
    },
    texSubImage2D: (...args: unknown[]) => {
      if (args.length === 7) uploads++
    },
  }
  const gl = new Proxy(impl, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined
      if (prop in target) return target[prop]
      if (/^[A-Z][A-Z0-9_]*$/.test(prop)) {
        if (!consts.has(prop)) consts.set(prop, next++)
        return consts.get(prop)
      }
      return () => (prop.startsWith('create') ? { kind: prop } : undefined)
    },
  }) as unknown as WebGL2RenderingContext
  return { gl, uploads: () => uploads, allocs: () => allocs }
}

const layer = (clipId: string, scale: number): RenderLayer => ({
  clipId,
  assetId: 'a1',
  sourceTimeS: 0,
  isImage: false,
  speed: 1,
  frameSeed: 0,
  transform: { ...defaultTransform(), scale, cropT: 0, cropR: 0, cropB: 0, cropL: 0 },
  opacity: 1,
  blendMode: 'normal',
  effects: [],
})

const frameOf = (layers: RenderLayer[]): RenderFrame => ({
  width: 320,
  height: 180,
  ops: layers.map((l) => ({ type: 'layer' as const, layer: l })),
})

describe('a changing source is uploaded once per frame, however many layers draw it', () => {
  for (const fastSourceUpload of [false, true]) {
    const road = fastSourceUpload ? 'the preview (staged upload)' : 'the export (direct upload)'

    it(`${road}: two layers on one picture upload it once`, () => {
      const { gl, uploads } = countingGl()
      const r = createRenderer(gl, { mipmapSources: true, fastSourceUpload })
      const picture = { width: 320, height: 180 } as unknown as TexImageSource
      r.render(frameOf([layer('bg', 2), layer('fg', 1)]), () => picture)
      expect(uploads()).toBe(1)
      r.dispose()
    })

    it(`${road}: a new frame uploads again, and two different pictures upload twice`, () => {
      const { gl, uploads } = countingGl()
      const r = createRenderer(gl, { mipmapSources: true, fastSourceUpload })
      const picture = { width: 320, height: 180 } as unknown as TexImageSource
      r.render(frameOf([layer('fg', 1)]), () => picture)
      r.render(frameOf([layer('fg', 1)]), () => picture) // the element moved on: same object, new pixels
      expect(uploads()).toBe(2)
      const other = { width: 320, height: 180 } as unknown as TexImageSource
      r.render(frameOf([layer('a', 1), layer('b', 1)]), (l) => (l.clipId === 'a' ? picture : other))
      expect(uploads()).toBe(4)
      r.dispose()
    })
  }
})

// PB-5, the rest of it, 2026-10-08. Every changing source shared ONE texture
// (and, on the preview's road, one staging texture), so a frame with two video
// layers of different sizes gave that texture new storage twice per frame,
// mip chain and all: a facecam over gameplay, a picture in picture. Two
// different elements at the same size (both sides of a dissolve) gave the
// staging texture new storage twice per frame, since a video element may only
// write in place into what it allocated itself. After the first frame, steady
// playback of the same layers should only write pixels into storage it has.
describe('steady playback of several video layers allocates nothing after its first frame', () => {
  for (const fastSourceUpload of [false, true]) {
    const road = fastSourceUpload ? 'the preview (staged upload)' : 'the export (direct upload)'

    it(`${road}: two pictures of different sizes`, () => {
      const { gl, uploads, allocs } = countingGl()
      const r = createRenderer(gl, { mipmapSources: true, fastSourceUpload })
      const big = { width: 320, height: 180 } as unknown as TexImageSource
      const small = { width: 96, height: 54 } as unknown as TexImageSource
      const frame = frameOf([layer('game', 1), layer('cam', 0.3)])
      const source = (l: RenderLayer) => (l.clipId === 'game' ? big : small)
      r.render(frame, source)
      const warm = allocs()
      for (let i = 0; i < 3; i++) r.render(frame, source)
      expect(uploads()).toBe(8) // every frame still uploads both pictures
      expect(allocs()).toBe(warm)
      r.dispose()
    })

    it(`${road}: two video elements of the same size (a dissolve)`, () => {
      const { gl, uploads, allocs } = countingGl()
      const r = createRenderer(gl, { mipmapSources: true, fastSourceUpload })
      const from = { videoWidth: 320, videoHeight: 180 } as unknown as TexImageSource
      const to = { videoWidth: 320, videoHeight: 180 } as unknown as TexImageSource
      const frame = frameOf([layer('from', 1), layer('to', 1)])
      const source = (l: RenderLayer) => (l.clipId === 'from' ? from : to)
      r.render(frame, source)
      const warm = allocs()
      for (let i = 0; i < 3; i++) r.render(frame, source)
      expect(uploads()).toBe(8)
      expect(allocs()).toBe(warm)
      r.dispose()
    })
  }
})
