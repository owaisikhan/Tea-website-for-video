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
