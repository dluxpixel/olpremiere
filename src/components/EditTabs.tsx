import { Plus, X } from 'lucide-react'
import { useState, type KeyboardEvent, type MouseEvent } from 'react'
import { closeTab, switchTo, useEditTabs, type EditTab } from '../state/editTabs'
import { useStore } from '../state/store'
import { IconButton } from '../ui/Button'
import { ProjectsDialog } from './ProjectsDialog'

/**
 * The open edits, one tab each, across the top of the editor. His ask,
 * 2026-10-03: several edits open so he can copy between them, with only the one
 * he is on loaded (state/editTabs.ts says what asleep means).
 *
 * Dressed exactly like the left panel's tabs, his accent on the open one, so the
 * strip reads as part of the editor and not a browser bolted on top. A slim row
 * of its own under the top bar: the three columns below keep every pixel they had
 * across, and lose 32 down.
 */
export function EditTabs() {
  const tabs = useEditTabs((s) => s.tabs)
  const waking = useEditTabs((s) => s.waking)
  const openId = useStore((s) => s.project.id)
  const openName = useStore((s) => s.project.name)
  const [picking, setPicking] = useState(false)
  // A first ever start opens on a blank project that is not saved anywhere yet,
  // so it is not in the list. It still shows: it is the edit on screen.
  const shown: EditTab[] = tabs.some((t) => t.id === openId) ? tabs : [...tabs, { id: openId, name: openName }]
  const closable = shown.length > 1

  return (
    <nav
      data-testid="edit-tabs"
      aria-label="Open edits"
      className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-bg-panel px-3"
    >
      <div role="tablist" aria-label="Open edits" className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        {shown.map((t) => (
          <Tab
            key={t.id}
            tab={t}
            name={t.id === openId ? openName : t.name}
            open={t.id === openId}
            waking={waking === t.id}
            closable={closable}
          />
        ))}
      </div>
      <IconButton
        size="compact"
        label="Open another edit in a tab"
        data-testid="edit-tabs-add"
        onClick={() => setPicking(true)}
      >
        <Plus size={14} strokeWidth={1.5} />
      </IconButton>
      {picking && <ProjectsDialog view="active" onClose={() => setPicking(false)} />}
    </nav>
  )
}

function Tab({ tab, name, open, waking, closable }: { tab: EditTab; name: string; open: boolean; waking: boolean; closable: boolean }) {
  // Only the open edit can be behind on its save: a sleeping one was written
  // when he left it. Same dot and colours as the save indicator in the top bar.
  const saveState = useStore((s) => (open ? s.ui.saveState : 'saved'))
  const go = (): void => {
    if (!open) void switchTo(tab.id)
  }
  const close = (e: MouseEvent): void => {
    e.stopPropagation()
    void closeTab(tab.id)
  }
  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={open}
      aria-busy={waking || undefined}
      data-testid="edit-tab"
      data-name={name}
      data-project-id={tab.id}
      data-open={open ? 'true' : undefined}
      title={name}
      onClick={go}
      // Enter only: Space is play everywhere in this editor, and a tab that had
      // focus must not take it.
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'Enter') go()
      }}
      // A click never takes the keyboard focus: the shortcuts he presses next
      // belong to the edit, and a focused tab would wear the focus ring the moment
      // he did. The middle button's press is swallowed for the same reason, and so
      // the browser's autoscroll never starts. Whatever DID have focus lets go of
      // it, so a name half typed into the top bar is committed before the switch.
      onMouseDown={(e) => {
        e.preventDefault()
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && closable) close(e)
      }}
      className={`group/tab flex h-6 min-w-[72px] max-w-[200px] shrink-0 cursor-default items-center gap-1.5 rounded-field pl-2.5 text-[12px] font-medium transition-colors duration-[120ms] ${
        closable ? 'pr-1' : 'pr-2.5'
      } ${open ? 'bg-accent-quiet text-accent' : 'text-text-secondary hover:bg-bg-elevated hover:text-text-primary'} ${
        waking ? 'animate-pulse' : ''
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {saveState !== 'saved' && (
        <span
          data-testid="edit-tab-unsaved"
          aria-label={saveState === 'saving' ? 'Saving' : 'Not saved yet'}
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${saveState === 'saving' ? 'animate-pulse bg-text-muted' : 'bg-warning'}`}
        />
      )}
      {closable && (
        <button
          type="button"
          data-testid="edit-tab-close"
          aria-label={`Shut the ${name} tab`}
          title="Close this tab. It is saved first."
          onClick={close}
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-field transition-[color,opacity] duration-[120ms] hover:bg-bg-input hover:text-text-primary ${
            open ? 'opacity-100' : 'opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100'
          }`}
        >
          <X size={12} strokeWidth={1.5} />
        </button>
      )}
    </div>
  )
}
