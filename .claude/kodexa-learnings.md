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
| L-001 | 2026-09-24 | gap | Social reel of a 3D site: deterministic frame capture, not screen recording | type: 3d-website | logged |
| L-002 | 2026-09-24 | gotcha | `pkill -f "next start"` kills the shell that runs it | all | logged |

## Entries

### L-001 · 2026-09-24 · medium · gap
- **Said / saw:** "can u make such website shown in this video and the video too so i can post on Facebook"
- **Context:** scroll-driven WebGL tea site plus a 1080x1920 reel (`scripts/record-tea-reel.mjs`)
- **Lesson:** When a 3D site also needs a promo video, give the engine a `renderFrame(progress, time)` method and a `?capture` mode that exposes it on `window`, frame the page in an iframe inside a 1080x1920 layout (caption + laptop), and screenshot each frame with Playwright, then encode with ffmpeg. Headless SwiftShader renders about 1 frame per second, the result is perfectly smooth, and it re-records in minutes after any design change. Screen recording in headless Chromium stutters.
- **Scope:** type: 3d-website
- **Target in skill:** references/types/3d-website.md, new section "Promo video"
- **Status:** logged

### L-002 · 2026-09-24 · medium · gotcha
- **Said / saw:** `pkill -f "next dev"; npm run build` exited 144 with no output
- **Context:** restarting servers between builds in a cloud session
- **Lesson:** `pkill -f <pattern>` matches the shell whose own command line contains the pattern and kills it. Find the PID with `ps aux | grep next-server` and `kill <pid>` instead.
- **Scope:** all
- **Target in skill:** SKILL.md section 5 (verification tooling notes)
- **Status:** logged
