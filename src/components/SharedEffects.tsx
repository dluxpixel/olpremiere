// The effects EVERY selected clip carries, with their settings, changed on all
// of them at once. His ask, 2026-09-29: *"when there is an effect on everything
// (for example, when there is auto color on everything), and I right-click and
// select all the clips that have auto color, I can change every single one at
// the same time."* The actions live in state/sharedEffects.ts.

import { Power, X } from 'lucide-react'
import { getEffect, paramSens } from '../engine/effects/registry'
import type { Clip } from '../engine/types'
import { playheadLocalT } from '../state/clipEdits'
import {
  removeSharedEffect,
  resetSharedEffectParam,
  setSharedEffectEnabled,
  setSharedEffectParam,
  sharedEffectTypes,
  sharedEnabled,
  sharedParamValue,
} from '../state/sharedEffects'
import { IconButton } from '../ui/Button'
import { PropRow, ScrubField, SectionLabel } from './EffectControls'
import { plural } from '../engine/plural'

export function SharedEffects({ clips }: { clips: Clip[] }) {
  const types = sharedEffectTypes(clips)
  if (types.length === 0) return null
  const ids = clips.map((c) => c.id)
  return (
    <section className="flex flex-col gap-2" data-testid="shared-effects">
      <SectionLabel>{clips.length === 1 ? 'On this clip' : `On all ${plural(clips.length, 'clip')}`}</SectionLabel>
      {types.map((type) => (
        <SharedEffectCard key={type} type={type} clips={clips} ids={ids} />
      ))}
    </section>
  )
}

function SharedEffectCard({ type, clips, ids }: { type: string; clips: Clip[]; ids: string[] }) {
  const def = getEffect(type)
  if (!def) return null
  const enabled = sharedEnabled(clips, type)
  return (
    <div className="rounded-overlay border border-border bg-bg-elevated p-2" data-testid="shared-effect" data-effect-type={type}>
      <div className="mb-1 flex items-center gap-1.5">
        <IconButton
          label={enabled === 'on' ? `Turn ${def.label} off on all` : `Turn ${def.label} on on all`}
          active={enabled === 'on'}
          size="compact"
          data-testid="shared-effect-toggle"
          onClick={() => setSharedEffectEnabled(ids, type, enabled !== 'on')}
        >
          <Power size={13} strokeWidth={1.75} aria-hidden />
        </IconButton>
        <span className="flex-1 truncate text-ui font-medium text-text-primary">
          {def.label}
          {enabled === 'mixed' && <span className="ml-1.5 text-dense font-normal text-text-muted">(off on some)</span>}
        </span>
        <IconButton
          label={`Remove ${def.label} from all ${ids.length}`}
          size="compact"
          data-testid="shared-effect-remove"
          onClick={() => removeSharedEffect(ids, type)}
        >
          <X size={13} strokeWidth={1.75} aria-hidden />
        </IconButton>
      </div>
      <div className="flex flex-col gap-1">
        {def.params.map((param) => {
          // Read at the playhead without subscribing to it: a panel that
          // re-renders every played frame is the lag his big edits already paid for.
          const { value, mixed } = sharedParamValue(clips, type, param.key, playheadLocalT)
          return (
            <PropRow
              key={param.key}
              data-testid={`shared-channel-${param.key}`}
              label={mixed ? `${param.label} (mixed)` : param.label}
              labelTitle={mixed ? `${param.label} differs between the clips. Changing it sets every one to the same value` : param.label}
              onReset={() => resetSharedEffectParam(ids, type, param.key)}
              resetLabel={`Reset ${param.label} on all`}
            >
              <ScrubField
                value={value}
                spec={{ min: param.min, max: param.max, step: param.step, sens: paramSens(param) }}
                testId={`shared-field-${param.key}`}
                ariaLabel={`${def.label} ${param.label} (all)`}
                onCommit={(v) => setSharedEffectParam(ids, type, param.key, v)}
              />
            </PropRow>
          )
        })}
      </div>
    </div>
  )
}
