// Runs the ray-traced kettle on a canvas with vgpu (WebGPU). Drag to orbit, wheel to zoom.

import { clock, effect, frameLoop, init, sampler, surface, texture } from "vgpu";
import type { FrameLoopHandle } from "vgpu";
import kettleShader from "./kettle.wgsl";
import { DEFAULT_VIEW, kettleView } from "./camera";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export type KettleState = { brew: number; level: number; lid: boolean };

export type KettleHandle = {
  update: (state: Partial<KettleState>) => void;
  dispose: () => void;
};

export function startKettle(canvas: HTMLCanvasElement, initial: KettleState, onError: (e: unknown) => void): KettleHandle {
  let disposed = false;
  let loop: FrameLoopHandle | undefined;
  let gpu: Awaited<ReturnType<typeof init>> | undefined;
  const state = { ...initial };
  // Orbit, eased toward where the pointer leaves it.
  const target = { ...DEFAULT_VIEW };
  const view = { ...DEFAULT_VIEW };
  let drag: { id: number; x: number; y: number } | null = null;

  const down = (e: PointerEvent) => {
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    target.yaw -= (e.clientX - drag.x) * 0.006;
    target.pitch = Math.min(1.0, Math.max(0.02, target.pitch + (e.clientY - drag.y) * 0.004));
    drag.x = e.clientX;
    drag.y = e.clientY;
  };
  const up = () => {
    drag = null;
  };
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    target.radius = Math.min(10, Math.max(4.6, target.radius * Math.exp(e.deltaY * 0.0012)));
  };
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("wheel", wheel, { passive: false });

  void (async () => {
    try {
      gpu = await init();
      if (disposed) return gpu.dispose();
      // Ray tracing every pixel is heavy: render at CSS resolution, never above 1.5x.
      const out = surface(gpu, canvas, { dpr: [1, 1.5] });
      const kettle = effect(gpu, kettleShader, { label: "kettle" });
      // Standalone mode paints its own room, so the site-frame inputs get a blank texture.
      const blank = texture(gpu, { kind: "2d", size: [1, 1], format: "rgba8unorm", usage: ["texture_binding", "copy_dst"] });
      kettle.set({ scene_tex: blank, scene_samp: sampler(gpu) });
      // Compile before the first frame, so a device that cannot run it falls back to the still.
      await kettle.compile(out);
      if (disposed) return;
      const time = clock(gpu);
      loop = frameLoop(gpu, (frame) => {
        const k = 1 - Math.exp(-Math.min(time.deltaTime, 0.1) * 8);
        view.yaw += (target.yaw - view.yaw) * k;
        view.pitch += (target.pitch - view.pitch) * k;
        view.radius += (target.radius - view.radius) * k;
        // A slow drift keeps the reflections alive when nobody is dragging.
        const yaw = view.yaw + (drag ? 0 : Math.sin(time.time * 0.15) * 0.12);
        kettle.set({
          params: {
            resolution: out.size,
            time: time.time,
            level: state.level,
            brew: state.brew,
            lid: state.lid ? 1 : 0,
            exposure: 1.1,
            site: 0,
            boil: 0,
            pot_to_world: IDENTITY,
            world_to_pot: IDENTITY,
            ...kettleView(yaw, view.pitch, view.radius),
          },
        });
        frame.pass(out, kettle);
      });
    } catch (e) {
      onError(e);
    }
  })();

  return {
    update: (s) => Object.assign(state, s),
    dispose: () => {
      disposed = true;
      loop?.stop();
      gpu?.dispose();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("wheel", wheel);
    },
  };
}
