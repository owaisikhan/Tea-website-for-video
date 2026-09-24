import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Kinari reel",
  robots: { index: false, follow: false },
};

// A 1080x1920 frame for recording the social video: caption on top and the
// live site inside a laptop. scripts/record-tea-reel.mjs drives it.
export default function TeaReel() {
  return (
    <main className="tea-root relative h-[1920px] w-[1080px] overflow-hidden bg-[#030201] text-white">
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(70% 30% at 50% 58%, rgba(120,70,25,0.22), transparent 70%), linear-gradient(#080605, #020101 60%, #050403)",
        }}
      />

      <div className="absolute inset-x-0 top-[250px] text-center text-[44px] leading-[1.45] font-medium">
        <p>Client: I don&apos;t want a basic website</p>
        <p>Me: How&apos;s this?</p>
      </div>

      <div className="absolute left-1/2 top-[600px] w-[1040px] -translate-x-1/2">
        {/* Lid */}
        <div className="rounded-[24px] bg-[#161618] p-[16px] shadow-[0_0_140px_rgba(170,105,40,0.3)] ring-1 ring-white/10">
          <div className="relative h-[630px] w-[1008px] overflow-hidden rounded-[8px] bg-black">
            <iframe
              id="site"
              src="/?capture=1"
              title="Kinari site"
              width={1280}
              height={800}
              className="absolute left-0 top-0 origin-top-left border-0"
              style={{ transform: "scale(0.7875)" }}
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{ background: "linear-gradient(115deg, rgba(255,255,255,0.06), transparent 30%)" }}
            />
          </div>
        </div>
        {/* Base */}
        <div className="relative -mx-[20px] h-[22px] rounded-b-[20px] bg-gradient-to-b from-[#48484c] to-[#141416]">
          <div className="absolute left-1/2 top-0 h-[7px] w-[160px] -translate-x-1/2 rounded-b-[8px] bg-[#0c0c0e]" />
        </div>
        <div
          aria-hidden
          className="-mx-[20px] mt-3 h-[260px]"
          style={{ background: "radial-gradient(55% 60% at 50% 0%, rgba(200,130,55,0.14), transparent 75%)" }}
        />
      </div>
    </main>
  );
}
