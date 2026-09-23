import { useSyncExternalStore } from 'react'

/**
 * When the editor is on a phone (2026-09-23, his bus rides). Kept word for word
 * in step with the `phone` variant in src/index.css, so a class that hides a
 * desktop control and the component that swaps the layout always agree.
 *
 * The height half asks for a coarse pointer: a phone turned sideways is short,
 * but so is a desktop window he dragged small, and only the phone is a finger.
 */
export const PHONE_QUERY = '(max-width: 640px), (max-height: 500px) and (pointer: coarse)'

const media = (): MediaQueryList | null =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(PHONE_QUERY) : null

const subscribe = (onChange: () => void): (() => void) => {
  const m = media()
  if (!m) return () => {}
  m.addEventListener('change', onChange)
  return () => m.removeEventListener('change', onChange)
}

export const isPhoneLayout = (): boolean => media()?.matches ?? false

/** True while the screen is phone shaped. Turning the phone re-renders. */
export function usePhoneLayout(): boolean {
  return useSyncExternalStore(subscribe, isPhoneLayout, () => false)
}
