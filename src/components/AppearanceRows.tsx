// In, Out and Speed for a title, in the panel that edits everything else about it.
//
// Click one title and the panel that sets its font, colour and box had no way to
// make it pop, fade or slide: that lived only on the right click menu. Select two
// and an "Animation" row appeared with the entrance alone (2026-10-06). CapCut
// puts In, Out and the speed in the text panel. These rows run the menu's own
// actions on the menu's own lists, so the doors can never disagree.

import { DEFAULT_APPEARANCE_DUR, ENTRANCE_PRESETS, EXIT_PRESETS } from '../engine/anim/appearance'
import type { AppearanceSpec } from '../engine/types'
import { setClipsAppearance, setClipsAppearanceDur } from '../state/appearanceActions'
import { SPEED_MENU } from '../state/clipMenus'
import { PropRow } from './EffectControls'

const selectCls = 'h-6 w-[140px] cursor-default rounded-field bg-bg-input px-1.5 text-ui-sm text-text-primary'

/** The select value of a speed rung: its seconds, or 'auto'. */
const speedValue = (spec: 'auto' | number): string => (spec === 'auto' ? 'auto' : String(spec))

export function AppearanceRows({
  ids,
  spec,
  testIds,
  all = false,
}: {
  ids: readonly string[]
  /** What the rows show: the clip's own animation, or the first selected title's. */
  spec: AppearanceSpec | undefined
  testIds: { in: string; out: string; speed: string }
  /** Several clips: every label says it reaches all of them. */
  all?: boolean
}) {
  const suffix = all ? ' (all)' : ''
  const animated = !!(spec?.in || spec?.out)
  const dur = spec?.durS ?? DEFAULT_APPEARANCE_DUR
  // A rung is its seconds on every clip, so the shown choice is a plain match.
  // Auto sizes each clip to itself, so it has no number of its own to match.
  const rung = SPEED_MENU.find((s) => s.spec !== 'auto' && Math.abs(dur - s.spec) < 1e-3)
  return (
    <>
      <PropRow label="In" labelTitle={`How it comes on${suffix}`}>
        <select
          aria-label={`Entrance animation${suffix}`}
          data-testid={testIds.in}
          value={spec?.in ?? ''}
          onChange={(e) => setClipsAppearance(ids, { in: e.target.value || undefined })}
          className={selectCls}
        >
          <option value="">None</option>
          {ENTRANCE_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </PropRow>
      <PropRow label="Out" labelTitle={`How it goes off${suffix}`}>
        <select
          aria-label={`Exit animation${suffix}`}
          data-testid={testIds.out}
          value={spec?.out ?? ''}
          onChange={(e) => setClipsAppearance(ids, { out: e.target.value || undefined })}
          className={selectCls}
        >
          <option value="">None</option>
          {EXIT_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </PropRow>
      {/* Speed only means something once there is an In or an Out, the same
          rule the menu and setClipsAppearanceDur keep. */}
      {animated && (
        <PropRow label="Speed" labelTitle={`How long the In and Out take${suffix}`}>
          <select
            aria-label={`Animation speed${suffix}`}
            data-testid={testIds.speed}
            value={rung ? speedValue(rung.spec) : ''}
            onChange={(e) => setClipsAppearanceDur(ids, e.target.value === 'auto' ? 'auto' : Number(e.target.value))}
            className={selectCls}
          >
            {!rung && (
              <option value="" disabled>
                {`${dur.toFixed(2)} s`}
              </option>
            )}
            {SPEED_MENU.map((s) => (
              <option key={s.label} value={speedValue(s.spec)}>
                {s.label}
              </option>
            ))}
          </select>
        </PropRow>
      )}
    </>
  )
}
