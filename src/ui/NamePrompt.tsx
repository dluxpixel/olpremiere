import { useEffect, useRef, useState } from 'react'
import { answerNamePrompt, useNamePrompt, type NameRequest } from '../state/namePrompt'
import { Button } from './Button'
import { useEscapeToClose } from './useEscapeToClose'

/**
 * The one small "type a name" dialog (state/namePrompt.ts). Enter saves,
 * Escape or a click outside backs out. The field keeps what he typed and says
 * why a name will not do right under it, instead of closing and making him
 * start again.
 */
export function NamePrompt() {
  const request = useNamePrompt((s) => s.request)
  const ticket = useNamePrompt((s) => s.ticket)
  if (!request) return null
  // Keyed on the question, so a new one never inherits the last answer.
  return <NamePromptDialog key={ticket} request={request} />
}

function NamePromptDialog({ request }: { request: NameRequest }) {
  const [value, setValue] = useState(request.initial ?? '')
  const [tried, setTried] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  // The field answers its own Escape; this is for the press that lands anywhere else in the dialog.
  useEscapeToClose(() => answerNamePrompt(null))
  const problem = request.validate?.(value) ?? (value.trim() === '' ? 'Type a name first' : null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const save = (): void => {
    setTried(true)
    if (problem) return
    answerNamePrompt(value)
  }

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) answerNamePrompt(null)
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        data-testid="name-prompt"
        className="w-[320px] max-w-[calc(100vw-24px)] rounded-dialog border border-border bg-bg-elevated p-4 shadow-pop"
      >
        <div className="mb-2 text-ui font-semibold text-text-primary">{request.title}</div>
        <input
          ref={input}
          data-testid="name-prompt-input"
          aria-label={request.title}
          value={value}
          maxLength={request.maxLength}
          placeholder={request.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // The global keymap must not read his typing as editor shortcuts.
            e.stopPropagation()
            if (e.key === 'Enter') save()
            else if (e.key === 'Escape') answerNamePrompt(null)
          }}
          className="h-7 w-full rounded-field border border-border bg-bg-input px-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
        <div data-testid="name-prompt-problem" className="mt-1 min-h-[16px] text-[11px] text-danger">
          {tried && problem ? problem : ''}
        </div>
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => answerNamePrompt(null)}>
            Cancel
          </Button>
          <Button variant="primary" data-testid="name-prompt-save" onClick={save}>
            {request.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
