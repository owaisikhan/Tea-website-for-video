"use client";

import { useEffect, useRef, useState } from "react";
import type { KettleHandle, KettleState } from "./startKettle";

const INITIAL: KettleState = { brew: 0.85, level: 0.95, lid: true };

/** Live preview of the vgpu kettle, with a few controls to watch it brew. */
export function KettleLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<KettleHandle | null>(null);
  const [state, setState] = useState(INITIAL);
  const [status, setStatus] = useState<"loading" | "live" | "unsupported">("loading");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!("gpu" in navigator)) {
      queueMicrotask(() => setStatus("unsupported"));
      return;
    }
    let cancelled = false;
    let handle: KettleHandle | null = null;
    import("./startKettle").then(({ startKettle }) => {
      if (cancelled) return;
      handle = startKettle(canvas, INITIAL, () => setStatus("unsupported"));
      handleRef.current = handle;
      setStatus("live");
    });
    return () => {
      cancelled = true;
      handle?.dispose();
      handleRef.current = null;
    };
  }, []);

  const change = (s: Partial<KettleState>) => {
    setState((prev) => ({ ...prev, ...s }));
    handleRef.current?.update(s);
  };

  return (
    <div className="tea-root fixed inset-0 bg-[#050302] text-[#f4ead9]">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full cursor-grab active:cursor-grabbing" aria-label="Glass teapot of tea, drag to turn it" />
      {status === "unsupported" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src="/kettle/brewed.jpg" alt="Glass teapot of amber tea on a walnut table" className="absolute inset-0 h-full w-full object-cover" />
      )}

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-5 md:p-8">
        <div>
          <p className="text-[10px] uppercase tracking-[0.42em] text-[#c9a25a]">vgpu · WebGPU</p>
          <h1 className="font-tea-display mt-2 text-[34px] leading-none md:text-[44px]">
            The <em className="tea-gold italic">kettle</em>
          </h1>
          <p className="mt-3 max-w-[22rem] text-[13px] leading-relaxed text-[#f4ead9]/75">
            Ray traced glass: every pixel follows its light through the glass and the tea. Drag to turn it.
          </p>
        </div>
        {status === "unsupported" && (
          <p className="max-w-[16rem] text-right text-[12px] text-[#f4ead9]/70">
            This is a still. The live, draggable version needs WebGPU: Chrome or Edge on a computer.
          </p>
        )}
      </div>

      {status !== "unsupported" && (
        <div className="absolute inset-x-5 bottom-5 flex flex-wrap items-center gap-x-8 gap-y-3 rounded-2xl bg-black/35 px-5 py-4 text-[12px] backdrop-blur-sm md:inset-x-auto md:left-8 md:bottom-8">
          <label className="flex items-center gap-3">
            <span className="w-16 uppercase tracking-[0.2em] text-[#f4ead9]/70">Brew</span>
            <input type="range" min={0} max={1} step={0.01} value={state.brew} onChange={(e) => change({ brew: +e.target.value })} className="w-36 accent-[#e7c27a]" />
          </label>
          <label className="flex items-center gap-3">
            <span className="w-16 uppercase tracking-[0.2em] text-[#f4ead9]/70">Level</span>
            <input type="range" min={0.3} max={1.45} step={0.01} value={state.level} onChange={(e) => change({ level: +e.target.value })} className="w-36 accent-[#e7c27a]" />
          </label>
          <label className="flex min-h-11 items-center gap-3">
            <input type="checkbox" checked={state.lid} onChange={(e) => change({ lid: e.target.checked })} className="size-4 accent-[#e7c27a]" />
            <span className="uppercase tracking-[0.2em] text-[#f4ead9]/70">Lid</span>
          </label>
        </div>
      )}
    </div>
  );
}
