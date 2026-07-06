// Compact keyframe timeline for the selected clip's animated channels. One
// horizontal lane per animated channel; each keyframe is a diamond positioned
// by t across the clip duration. Presentational — every mutation goes through
// the clipEdits helpers. Times are LOCAL to the clip (0 = clip start).

import { useState } from 'react'
import { clipDurationS } from '../engine/timeline'
import { isChannelAnimated } from '../engine/keyframes'
import { ANIM_CHANNELS, type AnimChannel, type Clip, type Keyframe } from '../engine/types'
import { setKeyframeEase } from '../state/clipEdits'

const EASES: Keyframe['ease'][] = ['linear', 'hold', 'easeIn', 'easeOut', 'easeInOut']
const EASE_LABEL: Record<Keyframe['ease'], string> = {
  linear: 'Lin',
  hold: 'Hold',
  easeIn: 'In',
  easeOut: 'Out',
  easeInOut: 'InOut',
}

interface Selected {
  channel: AnimChannel
  t: number
}

function EaseControl({
  clipId,
  selected,
  ease,
}: {
  clipId: string
  selected: Selected
  ease: Keyframe['ease']
}) {
  return (
    <div
      className="flex items-center gap-0.5 rounded-[4px] bg-bg-input p-0.5"
      role="group"
      aria-label="Keyframe easing"
    >
      {EASES.map((e) => (
        <button
          key={e}
          type="button"
          aria-label={`Easing ${e}`}
          aria-pressed={e === ease}
          title={e}
          onClick={() => setKeyframeEase(clipId, selected.channel, selected.t, e)}
          className={`cursor-default rounded-[3px] px-1.5 py-0.5 text-[10px] transition-colors duration-[120ms] ${
            e === ease
              ? 'bg-accent-quiet text-accent'
              : 'text-text-secondary hover:bg-bg-elevated hover:text-text-primary'
          }`}
        >
          {EASE_LABEL[e]}
        </button>
      ))}
    </div>
  )
}

export function KeyframeLane({
  clip,
  playheadS,
  width = 200,
}: {
  clip: Clip
  playheadS: number
  fps?: number
  width?: number
}) {
  const [selected, setSelected] = useState<Selected | null>(null)

  const animated = ANIM_CHANNELS.filter((ch) => isChannelAnimated(clip, ch))
  if (animated.length === 0) return null

  const durS = clipDurationS(clip)
  // Local playhead position within the clip; may fall outside [0, durS].
  const localT = playheadS - clip.startS
  const frac = durS > 0 ? localT / durS : 0
  const showPlayhead = frac >= 0 && frac <= 1

  // Track width leaves room for the channel label gutter.
  const labelW = 56
  const trackW = Math.max(40, width - labelW)

  const selEase =
    selected &&
    (clip.keyframes?.[selected.channel]?.find((k) => Math.abs(k.t - selected.t) <= 1e-4)?.ease ??
      null)

  return (
    <div className="flex flex-col gap-1" data-testid="keyframe-lane">
      {animated.map((ch) => {
        const kfs = clip.keyframes?.[ch] ?? []
        return (
          <div key={ch} className="flex items-center gap-2" style={{ height: 18 }}>
            <span
              className="shrink-0 text-[10px] uppercase tracking-[0.04em] text-text-muted"
              style={{ width: labelW }}
            >
              {ch}
            </span>
            <div
              className="relative h-full flex-1 rounded-[3px] bg-bg-input"
              style={{ minWidth: trackW }}
            >
              {/* mid-line rail */}
              <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
              {showPlayhead && (
                <div
                  className="pointer-events-none absolute top-0 bottom-0 w-px bg-playhead"
                  style={{ left: `${frac * 100}%` }}
                />
              )}
              {kfs.map((k) => {
                const x = durS > 0 ? (k.t / durS) * 100 : 0
                const isSel = selected?.channel === ch && Math.abs(selected.t - k.t) <= 1e-4
                return (
                  <button
                    key={k.t}
                    type="button"
                    data-testid="keyframe"
                    aria-label={`${ch} keyframe at ${k.t.toFixed(2)}s`}
                    title={`${ch} @ ${k.t.toFixed(2)}s — ${k.ease}`}
                    onClick={() =>
                      setSelected(isSel ? null : { channel: ch, t: k.t })
                    }
                    className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-default rounded-[1px] transition-colors duration-[120ms]"
                    style={{
                      left: `${Math.min(100, Math.max(0, x))}%`,
                      background: isSel ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                      boxShadow: isSel ? '0 0 0 1px var(--color-accent)' : undefined,
                    }}
                  />
                )
              })}
            </div>
          </div>
        )
      })}
      {selected && selEase && (
        <div className="pl-[64px]">
          <EaseControl clipId={clip.id} selected={selected} ease={selEase} />
        </div>
      )}
    </div>
  )
}
