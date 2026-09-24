// Records the site as a 1080x1920 social video (Facebook / Instagram reel).
//
//   npm run build && npx next start -p 3100
//   node scripts/record-tea-reel.mjs            # writes media/kinari-reel.mp4
//
// Needs Playwright (global or local) and ffmpeg on PATH. Every frame is
// rendered at an exact scroll position and time, so the video is smooth no
// matter how slow the machine is.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const BASE = process.env.REEL_URL ?? "http://localhost:3100";
const OUT = process.env.REEL_OUT ?? "media/kinari-reel.mp4";
const FPS = 30;

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const root = execSync("npm root -g").toString().trim();
    return createRequire(join(root, "noop.js"))("playwright");
  }
}

// Section centres from src/lib/teaTimeline.ts: hold on each headline, glide between.
const STOPS = [0, 0.195, 0.345, 0.495, 0.645, 0.795, 1];
const FIRST_HOLD = 1.0;
const MOVE = 1.3;
const HOLD = 0.7;
const LAST_HOLD = 2.4;

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function schedule() {
  const keys = [];
  let t = 0;
  STOPS.forEach((p, i) => {
    keys.push({ t, p });
    const hold = i === 0 ? FIRST_HOLD : i === STOPS.length - 1 ? LAST_HOLD : HOLD;
    t += hold;
    keys.push({ t, p });
    if (i < STOPS.length - 1) t += MOVE;
  });
  return { keys, duration: t };
}

function progressAt(keys, t) {
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (t <= b.t) return b.t === a.t ? b.p : a.p + (b.p - a.p) * ease((t - a.t) / (b.t - a.t));
  }
  return keys[keys.length - 1].p;
}

const { chromium } = await loadPlaywright();
const { keys, duration } = schedule();
const frames = Math.round(duration * FPS);
const dir = mkdtempSync(join(tmpdir(), "reel-"));

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
await page.goto(`${BASE}/reel`);
const site = page.frames().find((f) => f.url().includes("capture"));
await site.waitForFunction(() => window.__tea, null, { timeout: 60000 });
await page.evaluate(() => document.fonts.ready);

console.log(`Recording ${frames} frames (${duration.toFixed(1)}s)`);
for (let i = 0; i < frames; i++) {
  const t = i / FPS;
  await site.evaluate(([p, time]) => window.__tea.frame(p, time), [progressAt(keys, t), 2 + t]);
  await page.screenshot({ path: join(dir, `f${String(i).padStart(4, "0")}.jpg`), type: "jpeg", quality: 94 });
  if (i % 30 === 0) console.log(`  ${i}/${frames}`);
}
await browser.close();

// A soft ambient pad so the reel is not silent; swap it for trending audio when posting.
const d = duration.toFixed(2);
const pad =
  "0.06*sin(2*PI*110*t)+0.07*sin(2*PI*220*t)*(0.7+0.3*sin(2*PI*0.13*t))" +
  "+0.05*sin(2*PI*277.18*t)*(0.6+0.4*sin(2*PI*0.21*t))+0.045*sin(2*PI*329.63*t)" +
  "+0.03*sin(2*PI*415.3*t)*(0.5+0.5*sin(2*PI*0.17*t))+0.02*sin(2*PI*554.37*t)";
mkdirSync("media", { recursive: true });
execSync(
  [
    "ffmpeg -y -loglevel error",
    `-framerate ${FPS} -i ${join(dir, "f%04d.jpg")}`,
    `-f lavfi -i "aevalsrc='${pad}|${pad}':s=44100:d=${d}"`,
    `-filter_complex "[1:a]lowpass=f=1800,aecho=0.8:0.7:120|240:0.35|0.25,afade=t=in:d=1.2,afade=t=out:st=${(duration - 1.5).toFixed(2)}:d=1.5,volume=1.4[a]"`,
    '-map 0:v -map "[a]"',
    "-c:v libx264 -preset slow -crf 22 -pix_fmt yuv420p -profile:v high -movflags +faststart",
    "-c:a aac -b:a 160k -shortest",
    OUT,
  ].join(" "),
  { stdio: "inherit" },
);
rmSync(dir, { recursive: true, force: true });
console.log(`Saved ${OUT}`);
