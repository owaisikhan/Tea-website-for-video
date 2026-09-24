// Proves the ray-traced kettle composes correctly with the site, without a WebGPU browser.
//
//   npm run build && npx next start -p 3100
//   node --experimental-strip-types scripts/verify-hybrid.mts [out-dir] [p1,p2,...]
//
// For each scroll position: the site renders its WebGL frame with the WebGL pot hidden
// (?capture=1&hybrid=probe) and reports the kettle's inputs; the same kettle shader then runs
// in site mode with vgpu in Node over that frame, and the kettle layer is composited on top,
// exactly as the browser composites the two canvases.

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { resolveShader } from "@vgpu/wgsl/runtime";
import { effect, init, sampler, target, texture } from "vgpu/node";

const BASE = process.env.SITE_URL ?? "http://localhost:3100";
const out = process.argv[2] ?? "media/kettle/site";
const points = (process.argv[3] ?? "0,0.3,0.5,0.64,0.8,0.95").split(",").map(Number);
const [W, H] = [1280, 800];
mkdirSync(out, { recursive: true });

async function loadPlaywright() {
  const name = "playwright"; // a dev tool, not a project dependency: global install is fine
  try {
    return await import(name);
  } catch {
    const root = execSync("npm root -g").toString().trim();
    return createRequire(join(root, "noop.js"))("playwright");
  }
}

// 1. Site frames (WebGL) and the kettle's inputs.
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.goto(`${BASE}/?capture=1&hybrid=probe`);
await page.waitForFunction(() => (window as unknown as { __tea?: unknown }).__tea, null, { timeout: 60000 });
const frames: { p: number; png: Buffer; params: Record<string, unknown> }[] = [];
for (const p of points) {
  const r = await page.evaluate((pp: number) => {
    const tea = (window as unknown as { __tea: { frame: (p: number, t: number) => void; kettleParams: () => unknown } }).__tea;
    tea.frame(pp, 3 + pp * 10);
    const c = document.querySelector("canvas") as HTMLCanvasElement;
    return { url: c.toDataURL("image/png"), params: tea.kettleParams() };
  }, p);
  frames.push({ p, png: Buffer.from(r.url.split(",")[1], "base64"), params: r.params as Record<string, unknown> });
}
await browser.close();

// 2. The kettle layer over each frame, with vgpu in Node.
const shader = await resolveShader({ entry: fileURLToPath(new URL("../src/components/kettle/kettle.wgsl", import.meta.url)) });
const gpu = await init();
const layer = target(gpu, { size: [W, H] });
const fx = effect(gpu, shader.wgsl);
const samp = sampler(gpu, { minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
for (const f of frames) {
  const site = PNG.sync.read(f.png);
  const tex = texture(gpu, { kind: "2d", size: [site.width, site.height], format: "rgba8unorm", usage: ["texture_binding", "copy_dst"] });
  gpu.device.queue.gpu.writeTexture({ texture: tex.gpu }, site.data, { bytesPerRow: site.width * 4 }, [site.width, site.height]);
  fx.set({ scene_tex: tex, scene_samp: samp, params: { ...f.params, resolution: [W, H], exposure: 0.95, site: 1 } });
  fx.draw(layer);
  const px = await layer.color.read({ mipLevel: 0, region: "all" });
  // Premultiplied "over", as the browser composites the transparent WebGPU canvas.
  const outPng = new PNG({ width: W, height: H });
  let covered = 0;
  for (let i = 0; i < W * H * 4; i += 4) {
    const a = px[i + 3] / 255;
    if (a > 0) covered++;
    for (let c = 0; c < 3; c++) outPng.data[i + c] = Math.round(px[i + c] + site.data[i + c] * (1 - a));
    outPng.data[i + 3] = 255;
  }
  const name = `p${String(f.p).replace(".", "_")}`;
  writeFileSync(join(out, `${name}-site.png`), f.png);
  writeFileSync(join(out, `${name}-hybrid.png`), PNG.sync.write(outPng));
  console.log(`${name}: kettle covers ${((covered / (W * H)) * 100).toFixed(1)}% of the frame`);
  tex.destroy();
}
gpu.dispose();
