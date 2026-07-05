import { useCallback, useState } from 'react'

export interface LayoutSizes {
  left: number
  right: number
  bottom: number
}

const KEY = 'reel.layout.v1'

const DEFAULTS: LayoutSizes = { left: 280, right: 300, bottom: 320 }

const LIMITS: Record<keyof LayoutSizes, [number, number]> = {
  left: [200, 520],
  right: [220, 520],
  bottom: [160, 640],
}

const clamp = (key: keyof LayoutSizes, v: number) =>
  Math.min(LIMITS[key][1], Math.max(LIMITS[key][0], v))

function load(): LayoutSizes {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as Partial<LayoutSizes>
    return {
      left: clamp('left', Number(parsed.left) || DEFAULTS.left),
      right: clamp('right', Number(parsed.right) || DEFAULTS.right),
      bottom: clamp('bottom', Number(parsed.bottom) || DEFAULTS.bottom),
    }
  } catch {
    return DEFAULTS
  }
}

/** Panel sizes for the three splitters; persisted to localStorage. */
export function useLayoutSizes() {
  const [sizes, setSizes] = useState<LayoutSizes>(load)

  const adjust = useCallback((key: keyof LayoutSizes, deltaPx: number) => {
    setSizes((prev) => {
      const next = { ...prev, [key]: clamp(key, prev[key] + deltaPx) }
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        // localStorage full/unavailable — layout just won't persist
      }
      return next
    })
  }, [])

  return { sizes, adjust }
}
