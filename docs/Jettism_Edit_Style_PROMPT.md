# OL Premiere × Jettism — Build & Workflow Spec

*Rewritten after reading your actual editor source (`ol-premiere-source.zip` on your desktop — internal name "OL Premiere", a TypeScript/Vite/React + WebGL editor, self-scored 85/100).*
*This replaces the generic style prompt: it maps the Jettism style onto what OL Premiere already does, what it's missing, and how to close the gap.*

> **Repo reality check (added 2026-07-13 when committing, code has moved past the zip this spec read):**
> - **Backlog item 1 (title stroke/outline) is DONE** — `TitleDef.outline {color, widthPx}` renders via
>   `strokeText` in `titleRaster.ts`, editable in the Inspector, preview==export e2e'd (commit `71bd01a`).
>   The white-with-black-outline look works today.
> - **The Effects tab is NOT a stub anymore** — effect registry + browser + drag-to-clip shipped in the
>   perfect-build P1; §B-6's "finish the stub" is stale, only the template-preset half of item 6 remains.
> - Titles also gained **entrance/exit pop animations** (appearance presets incl. a Bounce with the exact
>   0.7→1.1→1.0 shape item 4 asks for) — per-CLIP, not yet per-word, so item 4 becomes "apply the existing
>   preset per caption chunk".
> - Still genuinely missing, confirmed: **transcription/word-timing (items 2–3), SFX library (5),
>   template preset (6), auto-duck (7), beat detection (8).** The effective backlog starts at item 2.

---

## TL;DR (the honest verdict)

Your editor is **way more capable than it needs to be** for this style. Timeline, 9:16 export, keyframed transform (zoom), color grade, audio mixer, and an **in-app voice recorder** are all already built and tested. You are **~80% of the way** to one-click Jettism edits.

**The missing 20% is one subsystem: captions.** Jettism's #1 signature element — auto, word-by-word, white-with-black-outline, pop-in captions synced to the voiceover — **does not exist in your code** (no transcription, no word timing, no text stroke). That's the thing worth building. Almost everything else is a preset or a small addition, not new architecture.

---

## A. What OL Premiere ALREADY has (mapped to the Jettism style)

| Jettism requirement | Status | Where in your code |
|---|---|---|
| 9:16 vertical + aspect-correct MP4 export | ✅ Have | `engine/export/*`, `ExportDialog.tsx`, real muxing via `mp4-muxer`/`mediabunny` |
| Multi-track timeline, trim / split / ripple / roll / slip | ✅ Have | `engine/timeline.ts`, `engine/editPoints.ts`, `Timeline.tsx` (C = cut) |
| **Zoom / punch-in** (scale/pos/rot, keyframeable) + on-screen gizmo | ✅ Have | `Clip.transform` in `engine/types.ts`, `engine/keyframes.ts`, `KeyframeLane.tsx`, `MonitorTransformOverlay.tsx` |
| **Facecam PiP** (position a webcam layer over gameplay) | ✅ Have | transform + `opacity` + `blendMode` per clip; multi-track compositing in `engine/render/glRenderer.ts` |
| Speed-ups / fast sections | ✅ Have | `Clip.speed` in `engine/types.ts` |
| Punchy color grade (contrast/saturation/exposure/WB) | ✅ Have | GLSL effect stack in `engine/effects/registry.ts`, keyframeable via `render/resolve.ts` |
| Audio mixer, gains, fades, crossfade, meter, waveforms | ✅ Have | `engine/audio.ts`, `engine/export/audioMix.ts`, `MasterMeter.tsx`, `ClipWaveform.tsx` |
| **Record voiceover in-app** | ✅ Have | `state/voiceRecorder.ts` |
| Basic on-screen text (font, size, color, bold, shadow, bg box) | ✅ Have (basic) | `TitleDef` in `engine/types.ts`, `render/titleRaster.ts`, `TitleControls.tsx` |
| Save/apply a "look" as a preset | ✅ Have (color only) | `engine/effects/presets.ts`, `state/library.ts` |

**Translation:** you can already cut a Jettism-style Short today — record VO, layer facecam over gameplay, keyframe zoom punches, grade it punchy, mix audio, export 9:16. The part that's painful today is the captions.

---

## B. What it NEEDS — ranked by impact on this style

### 🔴 1. Auto-captions with word-level timing  *(the one that matters)*
**Gap:** no transcription anywhere in `src` (grep for transcribe/speech/whisper/subtitle/karaoke = empty). Captions are the defining Jettism element and there's no path to them except typing titles by hand.
**Build:** add `engine/captions/` that takes the VO/audio track → produces `{word, startS, endS}[]`.
- Options: **Whisper via `transformers.js`/`whisper-web` (WebGPU, runs local, free)** ← best fit, you're already all-browser; or the browser **Web Speech API** (quick hack, lower accuracy, no reliable word timings); or a cloud STT API (most accurate, needs a key).
- Output feeds the caption renderer below.

### 🔴 2. Word-by-word caption rendering
**Gap:** a title is one static text block for its whole duration (`newTitleClip`). Jettism shows **1–3 words at a time**. Doing that today = one title clip per word by hand = unusable.
**Build:** a new caption clip type (or extend `TitleDef`) that holds a **word list with per-word times** and renders only the active chunk at each frame. Group words into 1–3-word chunks. Render in `render/titleRaster.ts`.

### 🔴 3. Text stroke / outline on titles
**Gap:** `TitleDef` has `shadow` (soft) and `box` (bg rectangle) but **no stroke** (`titleRaster.ts` has no `strokeText`/`lineWidth`). The white-text-with-thick-black-outline look is impossible cleanly right now.
**Build (small, high impact):** add `strokeColor: string` + `strokeWidthPx: number` to `TitleDef`; in `titleRaster.ts` call `ctx.lineWidth = …; ctx.strokeStyle = …; ctx.strokeText()` *before* `fillText()`. ~15 lines. Do this even if you do nothing else.

### 🟠 4. Caption pop-in animation + keyword color
**Gap:** titles don't animate except via manual transform keyframes; no per-word color.
**Build:** a built-in caption animation (scale **70 % → 110 % → 100 %** over ~4 frames on each new chunk — reuse the existing keyframe/`transform` machinery as a preset) and an emphasis color (blue `#3B7DFF` / yellow `#FFD400`) you can toggle per word.

### 🟠 5. SFX library (one-click stingers)
**Gap:** no sound library (grep sfx/sound-effect = empty). You'd import hitmarker/vine-boom/whoosh/Minecraft sounds by hand every time.
**Build:** extend the Library (`state/library.ts`) with a bundled SFX pack in `public/sfx/`; one click drops the sound onto an audio track at the playhead.

### 🟠 6. One-click "Jettism" template/preset + finish the Effects tab
**Gap:** presets today are **color-only** and applied via the Inspector; the **Effects tab is still a stub** ("Arriving in Phase 4", see `LeftPanel.tsx` + scorecard).
**Build:** extend presets to also carry a **title/caption style** + export setting = a single "Jettism look" you apply in one click. Finish the drag-from-Effects-tab flow while you're in there.

### 🟡 7. Auto-duck music under VO (sidechain)
**Gap:** you have gains/fades but no automatic ducking. Jettism's music sits ~8 dB under the voice and drops on the payoff.
**Build:** in `engine/export/audioMix.ts`, lower the music bus by a set dB whenever the VO track is active (envelope follower or simple gate keyed off the VO clip ranges).

### 🟡 8. (Optional) Auto-zoom-on-beat / on-impact
**Gap:** punches are manual keyframes. Nice-to-have: detect beats/hits → auto-insert a scale punch.
**Build:** simple onset/beat detection → write `transform.scale` keyframes. Optional; manual keyframing already works.

> Everything in 🔴 is genuinely missing and is what stops "one-click Jettism." Everything in 🟠/🟡 is convenience/quality on top of features you already have.

---

## C. The rewritten workflow — "Cut a Jettism Short in OL Premiere"

**Today (with current features):**
1. Import gameplay + facecam. Put facecam on the top track, scale/position it to the top ~30 % with the monitor gizmo (`transform`).
2. Record VO with the in-app recorder (`voiceRecorder`).
3. Cut to the beat with `C`; delete dead air; bump boring parts with `Clip.speed`.
4. Add **zoom punches**: on each reveal/hit, keyframe `transform.scale` 1.0 → 1.12 over ~5 frames.
5. Grade: add `contrast` +, `saturation` +, small `exposure`; save it as a preset called "Jettism Punch."
6. Captions (painful today): add title clips manually. ← this is what Section B fixes.
7. Drop SFX on an audio track; set music ~ -20 LUFS under VO; fade.
8. Export 9:16 H.264.

**After you build B-1→B-4 (target):**
1–5 same, then: click **Auto-Caption** → it transcribes the VO, lays down word-by-word caption clips (white + black outline, pop-in, keyword color) synced automatically. Tweak emphasis words, done. That single button is the whole game.

---

## D. Build backlog (paste to your coding agent, in order)

```
1. [S] Title stroke/outline: add strokeColor + strokeWidthPx to TitleDef
       (engine/types.ts); render via ctx.strokeText before fillText
       (engine/render/titleRaster.ts); expose in TitleControls.tsx. +tests.
2. [M] Caption data model: new CaptionDef { words: {text,startS,endS}[],
       chunkSize:1..3, style } + a caption clip; render active chunk only
       in titleRaster.ts.
3. [L] Transcription: engine/captions/transcribe.ts using transformers.js
       Whisper (WebGPU) → word timings; wire an "Auto-Caption from VO" action.
4. [S] Caption pop-in preset: reuse transform keyframes (0.7→1.1→1.0 over 4f)
       applied per chunk; add keyword emphasis color toggle.
5. [M] SFX library: bundle public/sfx/*, add to state/library.ts, one-click
       insert at playhead onto an audio track.
6. [M] "Jettism" template preset: extend EffectPreset to include title/caption
       style; add the apply flow to the Effects tab (finish LeftPanel stub).
7. [S] Music auto-duck under VO in engine/export/audioMix.ts.
8. [S] Optional: beat/onset detect → auto scale-punch keyframes.
```
`[S]=small [M]=medium [L]=large`. Item 1 alone makes your captions *look* right; items 1–4 make them *automatic*.

---

## E. Target style parameters (what the caption engine should output)

Keep these as the defaults your new caption system produces:

```json
{
  "canvas": { "width": 1080, "height": 1920, "fps": 30 },
  "caption": {
    "mode": "word_by_word", "words_per_group": [1, 3], "sync": "voiceover",
    "font_weight": 900, "size_pct_of_height": 8,
    "fill": "#FFFFFF", "stroke_color": "#000000", "stroke_px": 9,
    "shadow": { "x": 0, "y": 4, "blur": 6, "opacity": 0.6 },
    "position": { "align": "center", "y_pct": 72 },
    "animation": { "type": "pop_scale", "keyframes_pct": [70, 110, 100], "duration_frames": 4 },
    "keyword_highlight_colors": ["#3B7DFF", "#FFD400"]
  },
  "motion": { "punch_in_zoom": { "from": 1.0, "to": 1.12, "duration_frames": 5 } },
  "audio": { "music_bed_lufs": -20, "duck_under_vo_db": -8, "drop_on": "payoff" },
  "color": { "saturation_pct": 13, "contrast_pct": 10, "exposure_stops": 0.1 }
}
```

**Structure per clip (unchanged):** Hook (0–2s) → Setup (2–8s) → Bait (8–15s) → Payoff (15–25s, biggest zoom+SFX+music) → Button (loop back). See `Jettism_Channel_Playbook.md` for the strategy behind it.

---

### Accuracy notes
- "Have" rows were verified against the actual source (types, engine, components) and the project's own `scorecard.json`.
- The three 🔴 gaps were confirmed by grep returning **no** transcription/word-timing/stroke code.
- Exact font/SFX/LUFS numbers are genre-standard targets to tune by ear/eye — your scorecard already flags audio + design polish as "ear/eye-gated," which is the right instinct.
