// How many times the renderer uploads a CHANGING source (a video frame) in one
// frame. PB-5, 2026-10-06: a clip over its own blurred background is two layers
// of one picture, and it was uploaded twice per frame with two mip chains.
// There is no GPU under vitest, so this counts the calls a stand-in WebGL2
// context receives, the same way exportDither.test.ts does.

import { describe, expect, it } from 'vitest'
import { createRenderer } from './glRenderer'
import { defaultTransform } from '../types'
import type { RenderFrame, RenderLayer } from './types'

/** A WebGL2 context that draws nothing and counts picture uploads. */
function countingGl(): { gl: WebGL2RenderingContext; uploads: () => number } {
  let uploads = 0
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
    texImage2D: (...args: unknown[]) => {
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
  return { gl, uploads: () => uploads }
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
