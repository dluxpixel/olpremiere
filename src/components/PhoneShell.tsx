import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Images, Rows3, SlidersHorizontal } from 'lucide-react'
import { Inspector } from './Inspector'
import { LeftPanel } from './LeftPanel'
import { Monitor } from './Monitor'
import { Timeline } from './Timeline'

/**
 * THE EDITOR ON A PHONE (2026-09-23). His words: "I am on the bus for 2 hours a
 * day, and I'm thinking: what if I edit videos on my phone?"
 *
 * The desktop's three columns and timeline do not fit a phone, so on a phone
 * the same panels are stacked: the picture on top, always visible, and under it
 * ONE of timeline, media or clip settings, picked from a tab bar at the bottom
 * where a thumb rests. Nothing here is a second copy of a panel: it is the very
 * same Monitor, Timeline, LeftPanel and Inspector the desktop draws, only
 * arranged for a hand. Held sideways, the picture moves to the left.
 */
export type PhoneTab = 'timeline' | 'media' | 'edit'

/** Anything can send him to a tab, e.g. adding a clip shows the timeline. */
export const PHONE_TAB_EVENT = 'olpremiere:phone-tab'
export const showPhoneTab = (tab: PhoneTab): void => {
  window.dispatchEvent(new CustomEvent<PhoneTab>(PHONE_TAB_EVENT, { detail: tab }))
}

function useBoxSize<T extends HTMLElement>(): [RefObject<T>, { w: number; h: number }] {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setSize({ w: Math.floor(el.clientWidth), h: Math.floor(el.clientHeight) })
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size]
}

function TabButton({
  tab,
  current,
  label,
  onPick,
  children,
}: {
  tab: PhoneTab
  current: PhoneTab
  label: string
  onPick: (t: PhoneTab) => void
  children: ReactNode
}) {
  const on = tab === current
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      data-testid={`phone-tab-${tab}`}
      onClick={() => onPick(tab)}
      className={`flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] font-medium transition-colors duration-[120ms] ${
        on ? 'text-accent' : 'text-text-secondary active:text-text-primary'
      }`}
    >
      {children}
      {label}
    </button>
  )
}

export function PhoneShell() {
  const [tab, setTab] = useState<PhoneTab>('timeline')
  const [boxRef, box] = useBoxSize<HTMLDivElement>()

  useEffect(() => {
    const onTab = (e: Event) => setTab((e as CustomEvent<PhoneTab>).detail)
    window.addEventListener(PHONE_TAB_EVENT, onTab)
    return () => window.removeEventListener(PHONE_TAB_EVENT, onTab)
  }, [])

  return (
    <div data-testid="phone-shell" className="flex min-h-0 flex-1 flex-col landscape:flex-row">
      <div className="flex h-[40%] min-h-0 shrink-0 border-b border-border landscape:h-auto landscape:w-[46%] landscape:border-r landscape:border-b-0">
        <Monitor />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div ref={boxRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {box.w > 0 &&
            (tab === 'timeline' ? (
              <Timeline height={box.h} />
            ) : tab === 'media' ? (
              <LeftPanel width={box.w} />
            ) : (
              <Inspector width={box.w} />
            ))}
        </div>
        <nav
          role="tablist"
          aria-label="Phone panels"
          className="flex shrink-0 border-t border-border bg-bg-panel pb-[env(safe-area-inset-bottom)]"
        >
          <TabButton tab="timeline" current={tab} label="Timeline" onPick={setTab}>
            <Rows3 size={20} strokeWidth={1.5} aria-hidden />
          </TabButton>
          <TabButton tab="media" current={tab} label="Media" onPick={setTab}>
            <Images size={20} strokeWidth={1.5} aria-hidden />
          </TabButton>
          <TabButton tab="edit" current={tab} label="Edit" onPick={setTab}>
            <SlidersHorizontal size={20} strokeWidth={1.5} aria-hidden />
          </TabButton>
        </nav>
      </div>
    </div>
  )
}
