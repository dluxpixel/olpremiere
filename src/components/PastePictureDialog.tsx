// The question every pasted picture asks: keep its background, or take it off.
//
// His pick, 2026-09-28, asked how the choice should work: ask on every paste.
// The look is the app's other small dialogs (Settings, Captions, Projects).

import { Loader2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  canRemoveBackground,
  cancelPicturePaste,
  keepBackground,
  removeBackground,
  usePastePicture,
} from '../state/picturePaste'
import { Button, IconButton } from '../ui/Button'

/** After this long the wait says why it is long: the first cutout starts CutStudio and loads its model. */
const SLOW_HINT_MS = 4000

export function PastePictureDialog() {
  const picture = usePastePicture((s) => s.picture)
  if (!picture) return null
  return <PastePictureCard url={picture.url} />
}

function PastePictureCard({ url }: { url: string }) {
  const phase = usePastePicture((s) => s.phase)
  const problem = usePastePicture((s) => s.problem)
  const working = phase === 'working'
  const canRemove = canRemoveBackground()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelPicturePaste()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) cancelPicturePaste()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Paste picture"
        data-testid="paste-picture-dialog"
        className="olp-pop w-[380px] max-w-[calc(100vw-24px)] rounded-dialog border border-border bg-bg-elevated shadow-pop"
      >
        <div className="flex h-11 items-center gap-2 border-b border-border px-4">
          <span className="text-ui font-semibold text-text-primary">Paste picture</span>
          <span className="ml-auto">
            <IconButton label="Cancel" data-testid="paste-picture-cancel" onClick={cancelPicturePaste}>
              <X size={16} strokeWidth={1.5} />
            </IconButton>
          </span>
        </div>

        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="flex h-[180px] items-center justify-center overflow-hidden rounded-field border border-border bg-bg-input">
            <img
              src={url}
              alt="The picture you pasted"
              data-testid="paste-picture-thumb"
              draggable={false}
              className="max-h-full max-w-full object-contain"
            />
          </div>

          {working && <WorkingLine />}
          {phase === 'failed' && problem && (
            <p role="alert" data-testid="paste-picture-problem" className="text-[12px] leading-5 text-danger">
              {problem} You can still paste it with its background.
            </p>
          )}

          {/* "Keep background" stays live while CutStudio works: changing his
              mind mid wait pastes the picture as it is and drops the cutout. */}
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" data-testid="paste-picture-keep" onClick={() => void keepBackground()}>
              Keep background
            </Button>
            <Button
              variant="primary"
              data-testid="paste-picture-remove"
              disabled={!canRemove || working}
              onClick={() => void removeBackground()}
            >
              Remove background
            </Button>
          </div>
          {!canRemove && (
            <p data-testid="paste-picture-web" className="text-[11px] leading-4 text-text-muted">
              Removing the background needs the desktop app.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function WorkingLine() {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), SLOW_HINT_MS)
    return () => window.clearTimeout(t)
  }, [])
  return (
    <p role="status" data-testid="paste-picture-working" className="flex flex-col gap-0.5 text-ui-sm text-text-primary">
      <span className="flex items-center gap-2">
        {/* In-progress work is an ember state, the same as the caption pill. */}
        <Loader2 size={13} strokeWidth={2} aria-hidden className="animate-spin text-ember" />
        Removing the background…
      </span>
      {slow && (
        <span className="pl-[21px] text-text-secondary">The first one can take a little longer.</span>
      )}
    </p>
  )
}
