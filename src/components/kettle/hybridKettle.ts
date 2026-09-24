// The ray-traced kettle as a transparent WebGPU layer over the site's three.js canvas.
//
// Each frame, right after three.js renders, the finished WebGL frame is copied into a WebGPU
// texture (copyExternalImageToTexture) and the kettle shader runs in site mode: it traces rays
// through the pot in the pot's own frame and reads the scene behind the glass from that copy,
// so leaves and spices inside are seen through real glass and tea. Pixels that miss the pot
// are transparent and the WebGL canvas below shows through.

import { effect, frame, init, sampler, surface, texture } from "vgpu";
import type { Texture } from "vgpu";
import kettleShader from "./kettle.wgsl";

export type KettleSceneParams = {
  time: number;
  level: number;
  brew: number;
  boil: number;
  lid: number;
  cam_pos: [number, number, number];
  cam_fwd: [number, number, number];
  cam_right: [number, number, number];
  cam_up: [number, number, number];
  tan_half_fov: number;
  pot_to_world: number[];
  world_to_pot: number[];
};

export type HybridKettle = {
  render: (source: HTMLCanvasElement, params: KettleSceneParams) => void;
  dispose: () => void;
};

export async function startHybridKettle(overlay: HTMLCanvasElement): Promise<HybridKettle> {
  const gpu = await init();
  try {
    const out = surface(gpu, overlay, { dpr: [1, 1.75], alphaMode: "premultiplied" });
    const samp = sampler(gpu, { minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    let sceneTex: Texture | null = null;
    let size: [number, number] = [0, 0];
    const fx = effect(gpu, kettleShader, { label: "kettle-site" });

    const ensureTexture = (w: number, h: number) => {
      if (sceneTex && size[0] === w && size[1] === h) return sceneTex;
      sceneTex?.destroy();
      sceneTex = texture(gpu, {
        kind: "2d",
        size: [w, h],
        format: "rgba8unorm",
        usage: ["texture_binding", "copy_dst", "render_attachment"],
        label: "site-frame",
      });
      size = [w, h];
      fx.set({ scene_tex: sceneTex, scene_samp: samp });
      return sceneTex;
    };

    // Compile up front: a device that cannot run the shader throws here and the site keeps
    // its WebGL kettle.
    ensureTexture(2, 2);
    fx.set({ params: blankParams(out.size) });
    await fx.compile(out);

    return {
      render(source, params) {
        const w = source.width;
        const h = source.height;
        if (!w || !h) return;
        const tex = ensureTexture(w, h);
        // Must run in the same task as the WebGL render, before the browser composites it.
        gpu.device.queue.gpu.copyExternalImageToTexture({ source }, { texture: tex.gpu }, [w, h]);
        fx.set({ params: { ...params, resolution: out.size, exposure: SITE_EXPOSURE, site: 1 } });
        frame(gpu, (f) => f.pass(out, fx));
      },
      dispose() {
        sceneTex?.destroy();
        gpu.dispose();
      },
    };
  } catch (e) {
    gpu.dispose();
    throw e;
  }
}

/** Matches the site renderer's toneMappingExposure, so colours through the glass are unchanged. */
const SITE_EXPOSURE = 0.95;

function blankParams(resolution: readonly [number, number]) {
  const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return {
    resolution,
    time: 0,
    level: 0.95,
    brew: 0,
    boil: 0,
    lid: 1,
    exposure: SITE_EXPOSURE,
    site: 1,
    cam_pos: [0, 2, 9],
    cam_fwd: [0, 0, -1],
    cam_right: [1, 0, 0],
    cam_up: [0, 1, 0],
    tan_half_fov: 0.3,
    pot_to_world: id,
    world_to_pot: id,
  };
}
