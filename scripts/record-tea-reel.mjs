// Records the site as a 1080x1920 social video (Facebook / Instagram reel).
//
//   npm run build && npx next start -p 3100
//   node scripts/record-tea-reel.mjs            # writes media/kinari-reel.mp4
//
// Needs Playwright (global or local) and ffmpeg on PATH. Every frame is
// rendered at an exact scroll position and time, so the video is smooth no
// matter how slow the machine is.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// One continuous scroll: a short settle on the first headline, then a steady
// glide through every section (easing only at the very start and end), then a
// rest on the final call to action.
const START_HOLD = 0.8;
const SCROLL = 15.5;
const END_HOLD = 2.4;
const duration = START_HOLD + SCROLL + END_HOLD;

function progressAt(t) {
  const u = Math.min(1, Math.max(0, (t - START_HOLD) / SCROLL));
  // Half linear, half ease-in-out: constant speed through the middle, no jolt at the ends.
  const eased = 0.5 - Math.cos(Math.PI * u) / 2;
  return 0.5 * u + 0.5 * eased;
}

const { chromium } = await loadPlaywright();
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
  await site.evaluate(([p, time]) => window.__tea.frame(p, time), [progressAt(t), 2 + t]);
  await page.screenshot({ path: join(dir, `f${String(i).padStart(4, "0")}.jpg`), type: "jpeg", quality: 94 });
  if (i % 30 === 0) console.log(`  ${i}/${frames}`);
}
// Soundtrack: the site's own music, rendered offline in the page for this exact scroll path.
const path = Array.from({ length: frames }, (_, i) => progressAt(i / FPS));
const wav = await site.evaluate(([p, fps]) => window.__tea.soundtrack(p, fps), [path, FPS]);
writeFileSync(join(dir, "sound.wav"), Buffer.from(wav, "base64"));
await browser.close();
mkdirSync("media", { recursive: true });
execSync(
  [
    "ffmpeg -y -loglevel error",
    `-framerate ${FPS} -i ${join(dir, "f%04d.jpg")}`,
    `-i ${join(dir, "sound.wav")}`,
    `-filter_complex "[1:a]afade=t=in:d=0.6,afade=t=out:st=${(duration - 1.8).toFixed(2)}:d=1.8[a]"`,
    '-map 0:v -map "[a]"',
    "-c:v libx264 -preset slow -crf 22 -pix_fmt yuv420p -profile:v high -movflags +faststart",
    "-c:a aac -b:a 160k -shortest",
    OUT,
  ].join(" "),
  { stdio: "inherit" },
);
rmSync(dir, { recursive: true, force: true });
console.log(`Saved ${OUT}`);
