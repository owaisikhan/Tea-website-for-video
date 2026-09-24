"use client";

import { useEffect, useRef, useState } from "react";
import { teaBrand, teaCta, teaNav, teaSections } from "@/content/tea";
import { TEA_SCROLL_PAGES, TEA_STOPS, smoothstep, teaCopyState } from "@/lib/teaTimeline";
import { cn } from "@/lib/utils";
import type { TeaEngine } from "./teaEngine";

declare global {
  interface Window {
    __tea?: { frame: (p: number, t: number) => void };
  }
}

function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.49s1.07 2.89 1.22 3.09c.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.7.63.71.23 1.36.2 1.87.12.57-.08 1.76-.72 2-1.41.25-.7.25-1.29.17-1.41-.07-.13-.27-.2-.57-.35zM12.04 21.5h-.01a9.4 9.4 0 0 1-4.8-1.32l-.34-.2-3.57.94.95-3.48-.22-.36a9.43 9.43 0 0 1-1.45-5.03c0-5.2 4.24-9.44 9.45-9.44 2.52 0 4.9.99 6.68 2.77a9.38 9.38 0 0 1 2.76 6.68c0 5.21-4.24 9.44-9.45 9.44zm8.04-17.48A11.3 11.3 0 0 0 12.04.7C5.77.7.67 5.8.67 12.07c0 2 .52 3.96 1.52 5.69L.57 23.7l6.08-1.6a11.33 11.33 0 0 0 5.39 1.37h.01c6.27 0 11.37-5.1 11.37-11.37 0-3.04-1.18-5.9-3.34-8.04z" />
    </svg>
  );
}

/** "in gold." -> "in" + italic gold "gold." */
function Title({ lines }: { lines: [string, string] }) {
  const words = lines[1].split(" ");
  const last = words.pop();
  return (
    <>
      <span className="block">{lines[0]}</span>
      <span className="block">
        {words.length > 0 && <>{words.join(" ")} </>}
        <em className="tea-gold font-normal italic">{last}</em>
      </span>
    </>
  );
}

export function TeaExperience() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<TeaEngine | null>(null);
  const copyRefs = useRef<(HTMLElement | null)[]>([]);
  const barRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<HTMLSpanElement>(null);
  const cueRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [capture, setCapture] = useState(false);
  const [webglError, setWebglError] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let raf = 0;
    const isCapture = new URLSearchParams(window.location.search).has("capture");
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const lite = coarse && (navigator.hardwareConcurrency ?? 8) <= 4;

    // Scroll position -> 0..1.
    const scrollProgress = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      return max > 0 ? window.scrollY / max : 0;
    };

    // Copy, progress bar and counter all follow the same progress as the scene.
    const applyOverlay = (p: number) => {
      teaSections.forEach((_, i) => {
        const el = copyRefs.current[i];
        if (!el) return;
        const { vis, offset } = teaCopyState(p, i);
        el.style.opacity = vis.toFixed(3);
        el.style.transform = `translate3d(0, ${(offset * 36).toFixed(1)}px, 0)`;
        el.style.filter = vis < 0.99 ? `blur(${((1 - vis) * 8).toFixed(1)}px)` : "none";
        el.style.pointerEvents = vis > 0.6 ? "auto" : "none";
        el.style.visibility = vis < 0.01 ? "hidden" : "visible";
      });
      if (barRef.current) barRef.current.style.transform = `scaleX(${Math.max(0.02, p)})`;
      if (countRef.current) {
        const i = Math.max(0, TEA_STOPS.findIndex((s) => p < s) - 1);
        countRef.current.textContent = `${String(Math.min(i + 1, 7)).padStart(2, "0")} / 07`;
      }
      if (cueRef.current) cueRef.current.style.opacity = String(1 - smoothstep(0.01, 0.05, p));
    };

    const overlayLoop = () => {
      const engine = engineRef.current;
      applyOverlay(engine ? engine.getProgress() : scrollProgress());
      raf = requestAnimationFrame(overlayLoop);
    };

    const onScroll = () => engineRef.current?.setProgress(scrollProgress());
    const onResize = () => {
      engineRef.current?.resize();
      onScroll();
    };
    const onPointer = (e: PointerEvent) =>
      engineRef.current?.setPointer((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    const onVisibility = () => {
      if (document.hidden) engineRef.current?.stop();
      else if (!isCapture) engineRef.current?.start();
    };

    import("./teaEngine")
      .then(async ({ TeaEngine }) => {
        await document.fonts.ready;
        if (cancelled) return;
        const engine = new TeaEngine({ canvas, lite });
        engineRef.current = engine;
        if (isCapture) {
          setCapture(true);
          window.__tea = {
            frame: (p, t) => {
              engine.renderFrame(p, t);
              applyOverlay(p);
            },
          };
        } else {
          engine.setProgress(scrollProgress());
          engine.start();
          raf = requestAnimationFrame(overlayLoop);
        }
        setReady(true);
      })
      .catch(() => {
        setWebglError(true);
        setReady(true);
        raf = requestAnimationFrame(overlayLoop);
      });

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    window.addEventListener("pointermove", onPointer, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    canvas.addEventListener("webglcontextlost", () => setWebglError(true));

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointer);
      document.removeEventListener("visibilitychange", onVisibility);
      engineRef.current?.dispose();
      engineRef.current = null;
      delete window.__tea;
    };
  }, []);

  const waLink = `https://wa.me/${teaBrand.whatsapp}?text=${encodeURIComponent(teaBrand.whatsappMessage)}`;

  return (
    <div className={cn("tea-root relative bg-[#050302] text-[#f4ead9]", capture && "tea-capture")}>
      {/* Scroll track */}
      <div aria-hidden style={{ height: `${TEA_SCROLL_PAGES * 100}svh` }} />

      <canvas
        ref={canvasRef}
        aria-hidden
        className={cn("fixed inset-0 h-svh w-screen", webglError && "invisible")}
      />
      {webglError && <div aria-hidden className="tea-fallback fixed inset-0" />}

      <div className="pointer-events-none fixed inset-0">
        {/* Header */}
        <header className="absolute inset-x-0 top-0 flex items-center justify-between px-5 py-5 md:px-10 md:py-7">
          <a href="#" className="pointer-events-auto leading-none" aria-label={`${teaBrand.name} home`}>
            <span className="font-tea-display block text-[22px] tracking-[0.32em] md:text-[26px]">{teaBrand.mark}</span>
            <span className="mt-1 block text-[9px] uppercase tracking-[0.45em] text-[#c9a25a]">{teaBrand.suffix}</span>
          </a>
          <nav aria-label="Main" className="hidden items-center gap-9 text-[12px] uppercase tracking-[0.2em] text-[#f4ead9]/75 md:flex">
            {teaNav.map((item) => (
              <a key={item} href="#" className="pointer-events-auto transition-colors hover:text-[#e7c27a]">
                {item}
              </a>
            ))}
          </nav>
          <a
            href={waLink}
            className="pointer-events-auto rounded-full border border-[#e7c27a]/60 px-5 py-2.5 text-[11px] uppercase tracking-[0.2em] text-[#f4ead9] transition-colors hover:bg-[#e7c27a] hover:text-[#1a1108]"
          >
            Order now
          </a>
        </header>

        {/* Section copy */}
        {teaSections.map((s, i) => {
          const first = i === 0;
          const last = i === teaSections.length - 1;
          return (
            <section
              key={s.id}
              ref={(el) => {
                copyRefs.current[i] = el;
              }}
              aria-label={s.title.join(" ")}
              style={{ opacity: first ? 1 : 0 }}
              className={cn(
                "absolute will-change-transform",
                "inset-x-5 top-[13svh] text-center",
                s.align === "center" && "md:inset-x-0 md:top-[12svh] md:mx-auto md:max-w-3xl",
                s.align === "left" && "md:inset-x-auto md:left-[7vw] md:top-[28svh] md:max-w-[30rem] md:text-left",
                s.align === "right" && "md:inset-x-auto md:right-[7vw] md:top-[28svh] md:max-w-[30rem] md:text-right",
              )}
            >
              <p className="text-[10px] uppercase tracking-[0.42em] text-[#c9a25a] md:text-[11px]">{s.eyebrow}</p>
              {first ? (
                <h1 className="font-tea-display mt-4 text-[clamp(48px,8vw,112px)] leading-[0.92] tracking-[-0.01em]">
                  <Title lines={s.title} />
                </h1>
              ) : (
                <h2 className="font-tea-display mt-4 text-[clamp(44px,6.6vw,96px)] leading-[0.92] tracking-[-0.01em]">
                  <Title lines={s.title} />
                </h2>
              )}
              <p
                className={cn(
                  "mt-5 max-w-[26rem] text-[14px] leading-relaxed text-[#f4ead9]/80 md:text-[15px]",
                  s.align === "center" && "mx-auto",
                  s.align === "right" ? "mx-auto md:mr-0 md:ml-auto" : s.align === "left" && "mx-auto md:mx-0",
                )}
              >
                {s.body}
              </p>
              {first && (
                <div className="mt-7 flex items-center justify-center gap-6">
                  <a href="#" className="tea-button">
                    {teaCta.primary}
                  </a>
                  <span className="text-[11px] uppercase tracking-[0.25em] text-[#f4ead9]/70">{teaCta.secondary}</span>
                </div>
              )}
              {last && (
                <div className={cn("mt-7 flex flex-wrap items-center justify-center gap-x-6 gap-y-3", s.align === "left" && "md:justify-start")}>
                  <a href={waLink} className="tea-button">
                    <WhatsAppIcon className="size-4" />
                    {teaCta.order}
                  </a>
                  <a href="#" className="py-3 text-[11px] uppercase tracking-[0.25em] text-[#f4ead9]/80 underline-offset-4 hover:underline">
                    {teaCta.explore}
                  </a>
                </div>
              )}
            </section>
          );
        })}

        {/* Progress */}
        <div className="absolute bottom-6 left-5 flex items-center gap-4 md:bottom-9 md:left-10">
          <span ref={countRef} className="text-[11px] tabular-nums tracking-[0.25em] text-[#f4ead9]/75">
            01 / 07
          </span>
          <div className="h-px w-24 bg-[#f4ead9]/20 md:w-40">
            <div ref={barRef} className="h-full origin-left bg-[#e7c27a]" style={{ transform: "scaleX(0.02)" }} />
          </div>
        </div>
        <div ref={cueRef} className="absolute bottom-6 right-5 flex items-center gap-3 md:bottom-9 md:right-10">
          <span className="text-[11px] uppercase tracking-[0.3em] text-[#f4ead9]/70">Scroll</span>
          <span className="tea-cue block h-8 w-px bg-[#e7c27a]/80" />
        </div>
      </div>

      {/* Fade in once the first frame is drawn */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none fixed inset-0 bg-[#050302] transition-opacity duration-1000",
          ready ? "opacity-0" : "opacity-100",
          capture && "hidden",
        )}
      />
    </div>
  );
}
