@AGENTS.md

Built with the kodexa-builder skill (v1.1.0). Load it for any new feature or
design work, and log preferences, corrections and reversals to
`.claude/kodexa-learnings.md` as they happen.

Palette exceptions: warm near-black and gold (the brief was a dark, gold-lit tea film)

## Layout

- `/` is the site. Copy: `src/content/tea.ts`. Scroll timing: `src/lib/teaTimeline.ts`.
- Scene: `src/components/tea/teaEngine.ts` (plain three.js, all procedural) and `shaders.ts`.
  `?capture=1` stops the render loop and exposes `window.__tea.frame(progress, time)` for recording.
- `/reel` is the 1080x1920 frame for the social video; `scripts/record-tea-reel.mjs` renders it
  frame by frame into `media/kinari-reel.mp4`.
- Refraction: `TeaEngine.render()` draws everything opaque into a half-res target first; glass,
  tea and the pour stream sample it (`uScene`). New transparent objects are skipped automatically.
- Leaves: `leafPhysics.ts` simulates every leaf once on load (SIM_P0..SIM_P1 of the scroll = SIM_SECONDS);
  the engine interpolates recorded frames by scroll, so playback is reversible. Shapes and textures in
  `leafModels.ts`. The lid lifts off onto the table while leaves go in.
- Music: `src/components/tea/teaSound.ts` (Web Audio pad + bells + pour, unlocked on first gesture, mute
  stored in localStorage). `window.__tea.soundtrack()` renders the same graph offline for the reel.
- Assets (`public/assets/`, CC0 from Poly Haven) load in `TeaEngine.loadAssets()`; the scene works without them
  (painted studio fallback in `shaders.ts`).
- Water surfaces: `surfaceShader` (ripples from `sim.entry`, boiling noise, clipped by vessel profile + inverse matrix).
  Ingredient kinds, sizes and physics live in the `ingredients` table in `leafModels.ts`.
