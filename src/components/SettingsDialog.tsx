// Settings: every persistent preference in one place. The split with the
// command palette is deliberate and load-bearing — the palette runs ACTIONS,
// this dialog holds the choices that persist between sessions. Preferences
// that already have an in-context home (the mic chevron, the monitor's quality
// picker) keep it; this is where they are ALSO discoverable, and where every
// new preference lands so they stop breeding in dropdown corners.

import { Bookmark, Monitor as MonitorIcon, Moon, Sparkles, Sun, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  CAPTION_LANGUAGES,
  getCaptionLanguage,
  setCaptionLanguage,
  type CaptionLanguage,
} from '../engine/captions/transcribeConfig'
import { resolvedTheme, setPreviewQuality, setTheme, useSettings, type PreviewQuality, type ThemeChoice } from '../state/settings'
import { useStore } from '../state/store'
import { useToasts } from '../state/toasts'
import {
  defaultTrackPresetId,
  listTrackPresets,
  saveTrackPresetFromCurrent,
  setDefaultTrackPreset,
} from '../state/trackTemplate'
import { listAudioInputs, setInputDevice, useRecorder } from '../state/voiceRecorder'
import { Button, IconButton } from '../ui/Button'
import { resetQuickStart } from './QuickStart'

/** One labelled preference row on the settings grid. */
function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 py-2">
      <div className="min-w-0">
        <div className="text-ui text-text-primary">{label}</div>
        {hint && <div className="text-ui-sm text-text-muted">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </div>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border px-4 py-2 last:border-b-0">
      <h3 className="pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">{title}</h3>
      {children}
    </section>
  )
}

const SELECT_CLS =
  'h-7 cursor-default rounded-field border border-border bg-bg-input px-2 text-ui-sm text-text-primary'

const THEMES: { value: ThemeChoice; label: string; Icon: typeof Moon }[] = [
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'claude', label: 'Claude', Icon: Sparkles },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'system', label: 'System', Icon: MonitorIcon },
]

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const theme = useSettings((s) => s.theme)
  const previewQuality = useSettings((s) => s.previewQuality)
  const snapping = useStore((s) => s.ui.snapping)
  const setUI = useStore((s) => s.setUI)
  const selectedInputId = useRecorder((s) => s.selectedInputId)
  const [language, setLanguage] = useState<CaptionLanguage>(getCaptionLanguage)
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([])
  // The presets live in localStorage, not a store, so this row keeps its own
  // copy and re-reads after every action it takes.
  const [presets, setPresets] = useState(listTrackPresets)
  const [defaultId, setDefaultId] = useState(defaultTrackPresetId)
  const show = useToasts((s) => s.show)

  const refreshPresets = () => {
    setPresets(listTrackPresets())
    setDefaultId(defaultTrackPresetId())
  }

  // Device labels need one granted mic permission; listAudioInputs handles the
  // unlock, so the list fills in shortly after open on a fresh profile.
  useEffect(() => {
    void listAudioInputs().then(setInputs)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        data-testid="settings-dialog"
        className="max-h-[86vh] w-[480px] overflow-y-auto rounded-dialog border border-border bg-bg-elevated shadow-pop"
      >
        <div className="sticky top-0 flex h-11 items-center gap-2 border-b border-border bg-bg-elevated px-4">
          <span className="text-ui font-semibold text-text-primary">Settings</span>
          <span className="ml-auto">
            <IconButton label="Close settings" data-testid="settings-close" onClick={onClose}>
              <X size={14} strokeWidth={1.75} />
            </IconButton>
          </span>
        </div>

        <Group title="Appearance">
          <Row
            label="Theme"
            hint={
              theme === 'system'
                ? `Following the system: ${resolvedTheme('system')}`
                : theme === 'light'
                  ? 'Dark is recommended while grading: light surfaces bias how you read exposure'
                  : undefined
            }
          >
            <div className="flex items-center gap-1">
              {THEMES.map(({ value, label, Icon }) => (
                <button
                  key={value}
                  type="button"
                  data-testid={`theme-${value}`}
                  aria-pressed={theme === value}
                  onClick={() => setTheme(value)}
                  className={`flex h-7 items-center gap-1.5 rounded-field px-2 text-ui-sm transition-colors duration-[120ms] ${
                    theme === value
                      ? 'bg-accent text-accent-fg'
                      : 'bg-bg-input text-text-secondary hover:text-text-primary'
                  }`}
                >
                  <Icon size={13} strokeWidth={1.75} aria-hidden />
                  {label}
                </button>
              ))}
            </div>
          </Row>
        </Group>

        <Group title="Playback">
          <Row label="Preview quality" hint="What new sequences open at. Lower is smoother on heavy footage.">
            <select
              aria-label="Default preview quality"
              data-testid="settings-quality"
              className={SELECT_CLS}
              value={previewQuality}
              onChange={(e) => setPreviewQuality(Number(e.target.value) as PreviewQuality)}
            >
              <option value={1}>Full</option>
              <option value={0.5}>Half</option>
              <option value={0.25}>Quarter</option>
            </select>
          </Row>
          <Row label="Snapping" hint="Clips and the playhead stick to edges and markers.">
            <button
              type="button"
              data-testid="settings-snapping"
              aria-pressed={snapping}
              onClick={() => setUI({ snapping: !snapping })}
              className={`h-7 rounded-field px-3 text-ui-sm transition-colors duration-[120ms] ${
                snapping ? 'bg-accent text-accent-fg' : 'bg-bg-input text-text-secondary hover:text-text-primary'
              }`}
            >
              {snapping ? 'On' : 'Off'}
            </button>
          </Row>
        </Group>

        <Group title="Captions">
          <Row label="Spoken language" hint="Picks the local Whisper model. Czech uses the multilingual one.">
            <select
              aria-label="Caption language"
              data-testid="settings-language"
              className={SELECT_CLS}
              value={language}
              onChange={(e) => {
                const v = e.target.value as CaptionLanguage
                setLanguage(v)
                setCaptionLanguage(v)
              }}
            >
              {CAPTION_LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </Row>
        </Group>

        <Group title="Recording">
          <Row label="Microphone" hint="Which input voiceovers record from.">
            <select
              aria-label="Recording input"
              data-testid="settings-mic"
              className={`${SELECT_CLS} max-w-[200px]`}
              value={selectedInputId ?? ''}
              onChange={(e) => setInputDevice(e.target.value || null)}
            >
              <option value="">System default</option>
              {inputs.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone ${i + 1}`}
                </option>
              ))}
            </select>
          </Row>
        </Group>

        <Group title="New videos">
          <Row
            label="Track setup"
            hint={
              presets.length === 0
                ? 'Not set: new videos use the default tracks. Save one to pick it here.'
                : `New videos start from: ${presets.find((p) => p.id === defaultId)?.name ?? 'Not set'}`
            }
          >
            <select
              aria-label="Track setup for new videos"
              data-testid="settings-default-preset"
              className={`${SELECT_CLS} max-w-[160px]`}
              value={defaultId ?? ''}
              disabled={presets.length === 0}
              onChange={(e) => {
                setDefaultTrackPreset(e.target.value || null)
                refreshPresets()
              }}
            >
              <option value="">Not set</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              data-testid="settings-save-template"
              onClick={() => {
                // Same prompt as the timeline footer menu: there is no small
                // single-field dialog primitive to reuse yet.
                const name = window.prompt('Name this track setup', `Setup ${presets.length + 1}`)
                if (name === null) return
                saveTrackPresetFromCurrent(name)
                refreshPresets()
              }}
            >
              <Bookmark size={14} strokeWidth={1.5} />
              Save current
            </Button>
          </Row>
          <Row label="Quick start" hint="The three-step intro shown on a first visit.">
            <Button
              variant="secondary"
              data-testid="settings-reset-quickstart"
              onClick={() => {
                resetQuickStart()
                show('Quick start will show again on the next reload')
              }}
            >
              Show again
            </Button>
          </Row>
        </Group>
      </div>
    </div>
  )
}
