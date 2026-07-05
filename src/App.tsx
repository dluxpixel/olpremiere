import { useEffect } from 'react'
import { Inspector } from './components/Inspector'
import { LeftPanel } from './components/LeftPanel'
import { Monitor } from './components/Monitor'
import { Timeline } from './components/Timeline'
import { TopBar } from './components/TopBar'
import { quantizeToFrame } from './engine/timecode'
import { activeSequence } from './engine/types'
import { installKeymap } from './keymap'
import { saveNow } from './state/persistence'
import { useStore, zoomIn, zoomOut } from './state/store'
import { useToasts } from './state/toasts'
import { Splitter } from './ui/Splitter'
import { Toaster } from './ui/Toaster'
import { useLayoutSizes } from './useLayoutSizes'

function stepFrames(frames: number) {
  const s = useStore.getState()
  const seq = activeSequence(s.project)
  const t = quantizeToFrame(s.ui.playheadS, seq.fps) + frames / seq.fps
  s.setUI({ playheadS: Math.min(Math.max(0, t), seq.durationS) })
}

function useAppKeymap() {
  useEffect(() => {
    const store = () => useStore.getState()
    return installKeymap([
      { combo: 'mod+z', description: 'Undo', run: () => store().undo() },
      { combo: 'mod+shift+z', description: 'Redo', run: () => store().redo() },
      { combo: 'mod+y', description: 'Redo', run: () => store().redo() },
      {
        combo: 'mod+s',
        description: 'Save project',
        run: () => {
          void saveNow().then(() => useToasts.getState().show('Project saved', 'success'))
        },
      },
      { combo: 's', description: 'Toggle snapping', run: () => store().setUI({ snapping: !store().ui.snapping }) },
      { combo: 'v', description: 'Selection tool', run: () => store().setUI({ tool: 'select' }) },
      { combo: 'c', description: 'Razor tool', run: () => store().setUI({ tool: 'razor' }) },
      { combo: 'h', description: 'Hand tool', run: () => store().setUI({ tool: 'hand' }) },
      { combo: 'z', description: 'Zoom tool', run: () => store().setUI({ tool: 'zoom' }) },
      { combo: '=', description: 'Zoom in timeline', run: zoomIn },
      { combo: 'shift++', description: 'Zoom in timeline', run: zoomIn },
      { combo: '-', description: 'Zoom out timeline', run: zoomOut },
      { combo: 'shift+_', description: 'Zoom out timeline', run: zoomOut },
      { combo: 'arrowleft', description: 'Step 1 frame back', run: () => stepFrames(-1) },
      { combo: 'arrowright', description: 'Step 1 frame forward', run: () => stepFrames(1) },
      { combo: 'shift+arrowleft', description: 'Step ~1s back', run: () => stepFrames(-30) },
      { combo: 'shift+arrowright', description: 'Step ~1s forward', run: () => stepFrames(30) },
      { combo: 'home', description: 'Go to start', run: () => store().setUI({ playheadS: 0 }) },
      {
        combo: 'end',
        description: 'Go to end',
        run: () => store().setUI({ playheadS: activeSequence(store().project).durationS }),
      },
    ])
  }, [])
}

export default function App() {
  const { sizes, adjust } = useLayoutSizes()
  useAppKeymap()

  return (
    <div className="flex h-full select-none flex-col overflow-hidden text-[12px] text-text-primary">
      <TopBar />
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          <LeftPanel width={sizes.left} />
          <Splitter
            orientation="vertical"
            testId="splitter-left"
            onDrag={(d) => adjust('left', d)}
          />
          <Monitor />
          <Splitter
            orientation="vertical"
            testId="splitter-right"
            onDrag={(d) => adjust('right', -d)}
          />
          <Inspector width={sizes.right} />
        </div>
        <Splitter
          orientation="horizontal"
          testId="splitter-bottom"
          onDrag={(d) => adjust('bottom', -d)}
        />
        <Timeline height={sizes.bottom} />
      </div>
      <Toaster />
    </div>
  )
}
