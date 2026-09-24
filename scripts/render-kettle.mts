// Renders the vgpu kettle headless to PNG, straight from the same WGSL the page uses.
//
//   node --experimental-strip-types scripts/render-kettle.mts [out-dir] [--video]
//
// Needs a WebGPU adapter: `npx vgpu doctor` (on a machine without a GPU,
// `npx vgpu install-software-renderer` provides one).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { resolveShader } from "@vgpu/wgsl/runtime";
import { effect, init, target } from "vgpu/node";
import { kettleView } from "../src/components/kettle/camera.ts";

const out = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "media/kettle";
const [W, H] = [1280, 800];
mkdirSync(out, { recursive: true });

const shader = await resolveShader({ entry: fileURLToPath(new URL("../src/components/kettle/kettle.wgsl", import.meta.url)) });
const gpu = await init();
const colorTarget = target(gpu, { size: [W, H] });
const fx = effect(gpu, shader.wgsl);

const shots = [
  { name: "01-water", yaw: 0.35, pitch: 0.22, radius: 7.2, level: 0.95, brew: 0, lid: 1 },
  { name: "02-brewed", yaw: 0.35, pitch: 0.22, radius: 7.2, level: 0.95, brew: 1, lid: 1 },
  { name: "03-side", yaw: 1.2, pitch: 0.3, radius: 7.0, level: 0.95, brew: 1, lid: 1 },
  { name: "04-above-no-lid", yaw: -0.4, pitch: 0.75, radius: 6.4, level: 0.95, brew: 0.8, lid: 0 },
];
// `--video`: a turntable while clear water brews into tea, encoded with ffmpeg.
if (process.argv.includes("--video")) {
  const { execSync } = await import("node:child_process");
  const [VW, VH, FPS, SECONDS] = [960, 600, 24, 6];
  const frames = FPS * SECONDS;
  const vt = target(gpu, { size: [VW, VH] });
  const dir = join(out, "frames");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < frames; i++) {
    const u = i / (frames - 1);
    const ease = u * u * (3 - 2 * u);
    fx.set({ params: { resolution: [VW, VH], time: i / FPS, level: 0.95, brew: Math.min(1, ease * 1.3), lid: 1, exposure: 1.1, ...kettleView(0.1 + ease * 2.2, 0.2 + 0.1 * Math.sin(u * Math.PI), 7.2) } });
    fx.draw(vt);
    const png = new PNG({ width: VW, height: VH });
    png.data.set(await vt.color.read({ mipLevel: 0, region: "all" }));
    writeFileSync(join(dir, `f${String(i).padStart(4, "0")}.png`), PNG.sync.write(png));
    if (i % 24 === 0) console.log(`frame ${i}/${frames}`);
  }
  execSync(`ffmpeg -y -loglevel error -framerate ${FPS} -i ${join(dir, "f%04d.png")} -c:v libx264 -crf 20 -pix_fmt yuv420p -movflags +faststart ${join(out, "kettle-turntable.mp4")}`);
  gpu.dispose();
  process.exit(0);
}

for (const s of shots) {
  const t0 = Date.now();
  fx.set({ params: { resolution: [W, H], time: 1.5, level: s.level, brew: s.brew, lid: s.lid, exposure: 1.1, ...kettleView(s.yaw, s.pitch, s.radius) } });
  fx.draw(colorTarget);
  const pixels = await colorTarget.color.read({ mipLevel: 0, region: "all" });
  const png = new PNG({ width: W, height: H });
  png.data.set(pixels);
  writeFileSync(join(out, `${s.name}.png`), PNG.sync.write(png));
  console.log(`${s.name}: ${Date.now() - t0} ms`);
}
gpu.dispose();
