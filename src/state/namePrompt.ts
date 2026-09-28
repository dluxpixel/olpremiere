// Ask him for one short name, from anywhere, and wait for the answer.
//
// A context menu row is a button, so there is nowhere to type inside the menu.
// window.prompt is not an answer in the desktop app: Electron does not
// implement it, so "New category..." would silently do nothing there. This is
// the smallest thing that works in both: a store holding at most one open
// question, a promise for whoever asked, and one dialog (ui/NamePrompt.tsx)
// mounted once next to the context menu.

import { create } from 'zustand'

export interface NameRequest {
  /** The dialog's heading, like "New category". */
  title: string
  /** The words on the button that says yes. */
  confirmLabel: string
  initial?: string
  placeholder?: string
  maxLength?: number
  /** Why a name will not do, shown under the field, or null when it will. */
  validate?: (name: string) => string | null
}

interface NamePromptState {
  request: NameRequest | null
  resolve: ((name: string | null) => void) | null
  /** Counts questions, so the dialog starts empty for each new one. */
  ticket: number
}

export const useNamePrompt = create<NamePromptState>(() => ({ request: null, resolve: null, ticket: 0 }))

/**
 * Open the dialog and resolve with the trimmed name, or null when he backs out.
 * Asking again while one is open answers the first with null: two dialogs on
 * top of each other would leave one of them waiting forever.
 */
export function askForName(request: NameRequest): Promise<string | null> {
  useNamePrompt.getState().resolve?.(null)
  return new Promise((resolve) => {
    useNamePrompt.setState((s) => ({ request, resolve, ticket: s.ticket + 1 }))
  })
}

/** Close the dialog with his answer (null for Cancel or Escape). */
export function answerNamePrompt(name: string | null): void {
  const { resolve } = useNamePrompt.getState()
  useNamePrompt.setState({ request: null, resolve: null })
  resolve?.(name === null ? null : name.trim())
}
