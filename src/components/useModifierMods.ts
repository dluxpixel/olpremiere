import { useEffect, type RefObject } from 'react'
import { modifierMods } from './timelineLanes'

/**
 * Modifier-hover cursor language: holding Alt arms slip (clip body) and rate
 * stretch (edge), Ctrl+Alt arms slide (body) and roll (edge), and Alt flips
 * the zoom tool to zoom-out. Written straight to the container's dataset so
 * a held key never touches React state; index.css keys on
 * [data-tool][data-mods] to re-cursor the targets.
 */
export function useModifierMods(lanesRef: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const write = (ctrl: boolean, alt: boolean) => {
      const el = lanesRef.current
      if (!el) return
      const mods = modifierMods(ctrl, alt)
      if (mods) el.dataset.mods = mods
      else delete el.dataset.mods
    }
    const onKey = (e: KeyboardEvent) => write(e.ctrlKey || e.metaKey, e.altKey)
    // Alt+Tab and friends can steal the keyup: clear on window blur too.
    const clear = () => write(false, false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', clear)
    }
  }, [lanesRef])
}
