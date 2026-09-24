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

// Soundtrack: the site's own scroll sounds (see src/components/tea/teaSound.ts)
// over a soft pad. Swap in trending audio when posting if you prefer.
writeFileSync(join(dir, "sound.wav"), soundtrack(keys, duration));
mkdirSync("media", { recursive: true });
execSync(
  [
    "ffmpeg -y -loglevel error",
    `-framerate ${FPS} -i ${join(dir, "f%04d.jpg")}`,
    `-i ${join(dir, "sound.wav")}`,
    `-filter_complex "[1:a]aecho=0.8:0.6:90|180:0.25|0.15,afade=t=in:d=0.8,afade=t=out:st=${(duration - 1.5).toFixed(2)}:d=1.5[a]"`,
    '-map 0:v -map "[a]"',
    "-c:v libx264 -preset slow -crf 22 -pix_fmt yuv420p -profile:v high -movflags +faststart",
    "-c:a aac -b:a 160k -shortest",
    OUT,
  ].join(" "),
  { stdio: "inherit" },
);
rmSync(dir, { recursive: true, force: true });
console.log(`Saved ${OUT}`);

// ------------------------------------------------------------------ audio
// Offline version of the site's Web Audio sounds, written straight to a WAV.

function soundtrack(keys, duration) {
  const SR = 44100;
  const n = Math.ceil(duration * SR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const smooth = (a, b, v) => {
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const flowAt = (p) => smooth(0.5, 0.62, Math.min(1, Math.max(0, (p - 0.72) / 0.14)));

  // Resonant band-pass (RBJ cookbook), retuned every block.
  const bandpass = () => {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, b0 = 0, a1 = 0, a2 = 0, g = 1;
    return {
      tune(f, q) {
        const w = (2 * Math.PI * f) / SR;
        const alpha = Math.sin(w) / (2 * q);
        g = 1 / (1 + alpha);
        b0 = alpha;
        a1 = -2 * Math.cos(w);
        a2 = 1 - alpha;
      },
      run(x) {
        const y = g * (b0 * x - b0 * x2 - a1 * y1 - a2 * y2);
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        return y;
      },
    };
  };

  const whoosh = bandpass();
  const pour = bandpass();
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  let wGain = 0;
  let pGain = 0;
  let pFlicker = 1;
  const BLOCK = 256;
  for (let i = 0; i < n; i += BLOCK) {
    const t = i / SR;
    const v = (progressAt(keys, t + 0.02) - progressAt(keys, t - 0.02)) / 0.04;
    const speed = Math.min(Math.abs(v) / 0.25, 1);
    whoosh.tune(380 + speed * 1300, 0.7);
    if (Math.random() < 0.3) pFlicker = 0.75 + Math.random() * 0.5;
    pour.tune(1900 + Math.random() * 1100, 2.5);
    const flow = flowAt(progressAt(keys, t));
    for (let j = i; j < Math.min(n, i + BLOCK); j++) {
      wGain += (speed * speed * 0.35 - wGain) * 0.0004;
      pGain += (flow * 0.12 * pFlicker - pGain) * 0.002;
      const s = whoosh.run(noise()) * wGain + pour.run(noise()) * pGain;
      L[j] += s;
      R[j] += s;
    }
  }

  // Glass taps as each headline settles (a beat before the camera stops on it).
  const notes = [1318.5, 1480, 1568, 1760, 1975.5, 2093, 2349.3];
  const holds = keys.filter((_, i) => i % 2 === 0).slice(1);
  holds.forEach((k, idx) => {
    const t0 = Math.max(0, k.t - 0.3);
    const f = notes[(idx + 1) % notes.length];
    for (const [ratio, gain, decay] of [[1, 0.09, 1.6], [2.76, 0.035, 0.9], [5.4, 0.015, 0.5]]) {
      const start = Math.floor(t0 * SR);
      const len = Math.floor(decay * SR);
      for (let j = 0; j < len && start + j < n; j++) {
        const tt = j / SR;
        const env = Math.min(1, tt / 0.004) * Math.exp((-tt * 6.9) / decay);
        const s = Math.sin(2 * Math.PI * f * ratio * tt) * gain * env;
        L[start + j] += s * 0.9;
        R[start + j] += s;
      }
    }
  });

  // Soft pad underneath.
  const pad = [[110, 0.02], [220, 0.024], [277.18, 0.017], [329.63, 0.015], [415.3, 0.01]];
  for (let j = 0; j < n; j++) {
    const t = j / SR;
    let s = 0;
    for (const [f, g] of pad) s += Math.sin(2 * Math.PI * f * t) * g * (0.75 + 0.25 * Math.sin(2 * Math.PI * 0.15 * t + f));
    L[j] += s;
    R[j] += s * 0.95;
  }

  // Normalise to about -3 dB and write 16-bit stereo PCM.
  let peak = 0;
  for (let j = 0; j < n; j++) peak = Math.max(peak, Math.abs(L[j]), Math.abs(R[j]));
  const k = peak > 0 ? 0.7 / peak : 1;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let j = 0; j < n; j++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[j] * k)) * 32767), 44 + j * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[j] * k)) * 32767), 46 + j * 4);
  }
  return buf;
}
