# kodexa-builder learnings

This file is how this repo teaches the kodexa-builder skill. Every session
that loads the skill reads it first and appends to it as the user corrects,
reverses or chooses things. Entries promoted into the skill are marked with
the version they landed in. See the skill's `references/self-improvement.md`
for the rules.

- **Project:** tea-website-for-video (Kinari Tea House, moved out of igloo)
- **Type:** 3d-website
- **Who reads it daily:** strangers arriving from a Facebook post, mostly on phones
- **Palette exceptions:** warm near-black and gold (the brief was a dark, gold-lit tea film)
- **Skill version when started:** 1.1.0

## Summary

| ID | Date | Kind | Lesson (short) | Scope | Status |
|---|---|---|---|---|---|
| L-001 | 2026-09-24 | gap | Social reel of a 3D site: deterministic frame capture, not screen recording | type: 3d-website | promoted v1.3.0 |
| L-002 | 2026-09-24 | gotcha | `pkill -f "next start"` kills the shell that runs it | all | promoted v1.3.0 |
| L-003 | 2026-09-24 | correction | Photoreal product scenes: refraction pre-pass, Beer-Lambert liquids, CC0 HDRI and scanned textures, thick-shell glass | type: 3d-website | promoted v1.3.0 |
| L-004 | 2026-09-24 | rule | Falling and floating objects use a physics run baked on load and played back by scroll | type: 3d-website | promoted v1.3.0 |
| L-005 | 2026-09-24 | reversal | Sound is one continuous generative music bed that swells with scroll, not per-event whooshes and taps | type: 3d-website | promoted v1.3.0 |
| L-006 | 2026-09-24 | correction | No high-frequency motion driven by scroll (it reads as jitter); sway slowly | type: 3d-website | promoted v1.3.0 |
| L-007 | 2026-09-24 | correction | Physics must cover container motion (tilt) and whole-body containment at max size, proven by a scan | type: 3d-website | promoted v1.3.0 |
| L-008 | 2026-09-24 | correction | Attached parts join cleanly (start inside, clip by body profile); connected vessels share one liquid level | type: 3d-website | promoted v1.3.0 |
| L-009 | 2026-09-24 | rule | Iterate the site with screenshots; make slow derived outputs (videos) only when asked | all | promoted v1.3.0 |
| L-010 | 2026-09-24 | correction | Scanned raw ginger root rejected; ingredients must look like what goes into the brew | project | project |

## Entries

### L-001 · 2026-09-24 · medium · gap
- **Said / saw:** "can u make such website shown in this video and the video too so i can post on Facebook"
- **Context:** scroll-driven WebGL tea site plus a 1080x1920 reel (`scripts/record-tea-reel.mjs`)
- **Lesson:** When a 3D site also needs a promo video, give the engine a `renderFrame(progress, time)` method and a `?capture` mode that exposes it on `window`, frame the page in an iframe inside a 1080x1920 layout (caption + laptop), and screenshot each frame with Playwright, then encode with ffmpeg. Headless SwiftShader renders about 1 frame per second, the result is perfectly smooth, and it re-records in minutes after any design change. Screen recording in headless Chromium stutters.
- **Scope:** type: 3d-website
- **Target in skill:** references/types/3d-website.md, new section "Promo video"
- **Status:** promoted v1.3.0

### L-002 · 2026-09-24 · medium · gotcha
- **Said / saw:** `pkill -f "next dev"; npm run build` exited 144 with no output
- **Context:** restarting servers between builds in a cloud session
- **Lesson:** `pkill -f <pattern>` matches the shell whose own command line contains the pattern and kills it. Find the PID with `ps aux | grep next-server` and `kill <pid>` instead.
- **Scope:** all
- **Target in skill:** SKILL.md section 5 (verification tooling notes)
- **Status:** promoted v1.3.0

### L-003 · 2026-09-24 · medium · correction
- **Said / saw:** "improve textures and make it more realistic with smooth curves" then "improve this kettle to look more realistic, add textures, shine, and make curves look more natural, just like a kettle in real life ... see which library or code you can use to make it better"
- **Context:** glass teapot, tea liquid and table in the /tea scene; procedural-only shading looked fake
- **Lesson:** For a photoreal product scene, stay on plain three.js but (1) render the opaque scene into a half-res target first and let glass and liquids refract it; (2) colour liquids by Beer-Lambert absorption over depth; (3) reflect a CC0 HDRI from Poly Haven, squared and clamped so a bright studio reads as the scene's own room, sampled with a small mip bias; (4) use scanned CC0 PBR textures for surfaces like wood; (5) build glass as one closed lathe shell with real wall thickness from centripetal Catmull-Rom profiles.
- **Scope:** type: 3d-website
- **Target in skill:** references/types/3d-website.md, new section "Photoreal product scenes"
- **Status:** promoted v1.3.0

### L-004 · 2026-09-24 · strong · rule
- **Said / saw:** "fix the leaves, make them look more natural and add physics to them so that their drop look natural ... no static images"
- **Context:** tea leaves and spices pouring from a pouch into the pot
- **Lesson:** Simulate once on load (gravity, drag, flutter, splash, soaking buoyancy, currents, walls), record every object's position and rotation per frame against simulated time mapped to scroll, and interpolate by progress. It stays deterministic (video capture works), reversible (scrolling up rewinds) and cheap at runtime. Objects are real 3D shapes with cut-out painted textures and back-light translucency, never flat sprites.
- **Scope:** type: 3d-website
- **Target in skill:** references/types/3d-website.md, new section "Physics played back by scroll"
- **Status:** promoted v1.3.0

### L-005 · 2026-09-24 · strong · reversal
- **Said / saw:** "make the scroll continues and the music too, a continuous seamless scroll with smooth audio"
- **Context:** the first sound pass used a whoosh per scroll burst and a glass tap per section
- **Lesson:** Scroll sound is one continuous Web Audio music bed (pad whose chord glides per section, sparse bell notes whose density and brightness follow smoothed scroll speed, reverb), unlocked on the first gesture with a remembered mute button. Discrete per-event effects were rejected as choppy.
- **Scope:** type: 3d-website
- **Target in skill:** references/types/3d-website.md, new section "Sound"
- **Status:** promoted v1.3.0

### L-006 · 2026-09-24 · medium · correction
- **Said / saw:** "this packet skakes while moving make it smooth"
- **Context:** pouch shake was `sin(p * 900)`, so small scroll steps jumped it back and forth
- **Lesson:** Any oscillation driven by scroll progress must be low frequency (a few cycles across its section); high-frequency functions of progress alias into jitter with wheel steps.
- **Scope:** type: 3d-website
- **Target in skill:** references/types/3d-website.md, "Physics played back by scroll"
- **Status:** promoted v1.3.0

### L-007 · 2026-09-24 · medium · correction (repeated)
- **Said / saw:** "the kettle tilts but ingredients stay stuck on top", "the cinnamon still sticks out of the kettle which is not possible in real life, make sure no ingredients leaks out", "some other ingredients leak out of kettle base and sides too"
- **Context:** the physics run ended before the pour; containment checked only centres at the original size
- **Lesson:** Run the simulation across the whole timeline in the container's own frame, with gravity and the liquid surface rotated as the container moves. Contain every object by probe points on its ends and edges at its largest rendered size, and prove it with a scan over every recorded frame (zero outside), not by screenshots.
- **Scope:** type: 3d-website
- **Target in skill:** references/types/3d-website.md, "Physics played back by scroll"
- **Status:** promoted v1.3.0

### L-008 · 2026-09-24 · medium · correction (repeated)
- **Said / saw:** "the pouring starts but it looks discontinues as kettle funnel is not filled, and also funnel looks broken", then "fix this broken funnel, looks discontinues and not connected to kettle"
- **Context:** spout tube started partly outside the body and was empty while tea poured from its tip
- **Lesson:** Parts attached to a body (spouts, handles) start inside it and are clipped in the shader against the body's profile so the join is clean from every angle. Connected vessels share one liquid level, so a spout fills as the pot tips and the stream only starts when the level reaches the tip; the stream reaches its target at once and then thickens rather than growing in mid-air.
- **Scope:** type: 3d-website
- **Target in skill:** references/types/3d-website.md, "Photoreal product scenes"
- **Status:** promoted v1.3.0

### L-009 · 2026-09-24 · medium · rule
- **Said / saw:** "now lets just first improve the website and then move on to making a video, skip the video creation part for now"
- **Context:** each site iteration had re-recorded a 15 minute reel
- **Lesson:** Iterate on the source with screenshots; regenerate slow derived outputs (videos, reels, exports) only when asked, once the source is approved.
- **Scope:** all
- **Target in skill:** SKILL.md section 3, working style
- **Status:** promoted v1.3.0

### L-010 · 2026-09-24 · low · correction
- **Said / saw:** "remove this raw ginger too"
- **Context:** a scanned whole ginger root added among the brewing ingredients
- **Lesson:** Project taste: this brew uses sliced ginger, not a raw root. Recorded in this repo only.
- **Scope:** project
- **Target in skill:** none
- **Status:** project
