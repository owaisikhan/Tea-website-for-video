// Continuous, generative music for the page, synthesised with Web Audio (no files).
//
// - A warm pad holds one chord per section; when the scroll moves into a new
//   section every voice glides to the next chord, so the music never cuts.
// - Soft glassy bell notes drift over it, picked from the current chord. They
//   play more often, and the pad opens up, while the visitor is scrolling.
// - A gentle trickle joins in while the tea pours.
// - Everything runs through a generated reverb for a smooth, seamless tail.
//
// The same graph renders offline (renderSoundtrack) so the reel carries exactly
// the site's music. Browsers only allow live audio after a tap, click or key.

import { pourFlow, teaCenter } from "@/lib/teaTimeline";

// One chord per section (Hz), in D major: Dmaj9, Bm9, Gmaj7, Em9, A6sus, Gmaj9, Dmaj9.
const CHORDS = [
  [146.83, 220.0, 329.63, 369.99, 554.37],
  [123.47, 185.0, 293.66, 440.0, 554.37],
  [98.0, 146.83, 246.94, 369.99, 440.0],
  [164.81, 246.94, 293.66, 369.99, 392.0],
  [110.0, 164.81, 246.94, 293.66, 369.99],
  [98.0, 146.83, 220.0, 246.94, 369.99],
  [146.83, 220.0, 329.63, 369.99, 440.0],
];
const STEP = 0.42; // seconds between possible bell notes
const MASTER = 0.8;

function chordAt(p: number) {
  let best = 0;
  for (let i = 1; i < CHORDS.length; i++) if (p >= (teaCenter(i - 1) + teaCenter(i)) / 2) best = i;
  return best;
}

function impulse(ctx: BaseAudioContext, seconds: number) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  let seed = 3;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = r() * Math.pow(1 - i / len, 3.2);
  }
  return buf;
}

/** The audio graph and its scheduler, usable with a live or an offline context. */
class MusicGraph {
  readonly master: GainNode;
  private voices: OscillatorNode[][] = [];
  private padFilter: BiquadFilterNode;
  private padGain: GainNode;
  private bus: GainNode;
  private pourGain: GainNode;
  private pourFilter: BiquadFilterNode;
  private chord = -1;
  private nextNote = 0;
  private activity = 0;
  private lastTime = -1;
  private seed = 17;

  constructor(private ctx: BaseAudioContext) {
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);

    // Everything feeds one bus: dry to the master, and a generous reverb send.
    this.bus = ctx.createGain();
    const verb = ctx.createConvolver();
    verb.buffer = impulse(ctx, 3.4);
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
    this.bus.connect(this.master);
    this.bus.connect(verb).connect(wet).connect(this.master);

    // Pad: two slightly detuned oscillators per chord tone, through a soft low-pass.
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = "lowpass";
    this.padFilter.frequency.value = 700;
    this.padFilter.Q.value = 0.4;
    this.padGain = ctx.createGain();
    this.padGain.gain.value = 0.9;
    this.padFilter.connect(this.padGain).connect(this.bus);
    // Slow breathing on the pad.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.18;
    lfo.connect(lfoDepth).connect(this.padGain.gain);
    lfo.start(0);
    CHORDS[0].forEach((f, i) => {
      const g = ctx.createGain();
      g.gain.value = 0.045 / (1 + i * 0.25);
      const pair = [0, 5].map((cents, k) => {
        const o = ctx.createOscillator();
        o.type = k === 0 ? "sine" : "triangle";
        o.frequency.value = f;
        o.detune.value = cents;
        o.connect(g);
        o.start(0);
        return o;
      });
      g.connect(this.padFilter);
      this.voices.push(pair);
    });

    // Trickle while pouring: looping noise through a moving band-pass.
    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = this.rand() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    src.playbackRate.value = 0.8;
    this.pourFilter = ctx.createBiquadFilter();
    this.pourFilter.type = "bandpass";
    this.pourFilter.Q.value = 2.2;
    this.pourFilter.frequency.value = 2300;
    this.pourGain = ctx.createGain();
    this.pourGain.gain.value = 0;
    src.connect(this.pourFilter).connect(this.pourGain).connect(this.bus);
    src.start(0);
  }

  private rand() {
    this.seed = (this.seed * 16807) % 2147483647;
    return (this.seed - 1) / 2147483646;
  }

  fadeIn(time: number, level = MASTER) {
    this.master.gain.cancelScheduledValues(time);
    this.master.gain.setTargetAtTime(level, time, 0.9);
  }

  fadeOut(time: number) {
    this.master.gain.cancelScheduledValues(time);
    this.master.gain.setTargetAtTime(0, time, 0.25);
  }

  /** Advance the music to `time` (context seconds) for scroll progress p. */
  tick(time: number, p: number, velocity: number, lookahead = 0.12) {
    const dt = this.lastTime < 0 ? 0 : Math.max(0, time - this.lastTime);
    this.lastTime = time;
    // Activity rises quickly with scrolling and falls away slowly, so the music swells, never jolts.
    const target = Math.min(1, Math.abs(velocity) / 0.12);
    const rate = target > this.activity ? 3 : 0.7;
    this.activity += (target - this.activity) * (1 - Math.exp(-dt * rate));

    const chord = chordAt(p);
    if (chord !== this.chord) {
      CHORDS[chord].forEach((f, i) => this.voices[i].forEach((o) => o.frequency.setTargetAtTime(f, time, this.chord < 0 ? 0.01 : 0.7)));
      this.chord = chord;
    }
    this.padFilter.frequency.setTargetAtTime(650 + 1700 * this.activity, time, 0.35);

    const flow = pourFlow(p);
    this.pourGain.gain.setTargetAtTime(flow * 0.03 * (0.8 + this.rand() * 0.4), time, 0.2);
    this.pourFilter.frequency.setTargetAtTime(2000 + this.rand() * 900, time, 0.1);

    if (this.nextNote < time) this.nextNote = time;
    while (this.nextNote < time + lookahead) {
      if (this.rand() < 0.3 + 0.55 * this.activity) this.bell(this.nextNote);
      this.nextNote += STEP * (this.rand() < 0.25 ? 2 : 1);
    }
  }

  private bell(at: number) {
    const ctx = this.ctx;
    const tones = CHORDS[Math.max(0, this.chord)];
    const f = tones[1 + Math.floor(this.rand() * (tones.length - 1))] * (this.rand() < 0.6 ? 2 : 4);
    const out = ctx.createGain();
    const pan = ctx.createStereoPanner();
    pan.pan.value = (this.rand() - 0.5) * 0.8;
    const level = 0.03 * (0.6 + 0.4 * this.rand()) * (0.7 + 0.5 * this.activity);
    out.gain.setValueAtTime(0, at);
    out.gain.linearRampToValueAtTime(level, at + 0.012);
    out.gain.exponentialRampToValueAtTime(0.0001, at + 2.4);
    out.connect(pan).connect(this.bus);
    // A soft fundamental plus a faint inharmonic partial reads as glass, not a synth beep.
    for (const [ratio, g] of [
      [1, 1],
      [2.76, 0.18],
    ]) {
      const o = ctx.createOscillator();
      const og = ctx.createGain();
      o.frequency.value = f * ratio;
      og.gain.value = g;
      o.connect(og).connect(out);
      o.start(at);
      o.stop(at + 2.5);
    }
  }
}

/** Live music for the page. */
export class TeaSound {
  private ctx: AudioContext | null = null;
  private graph: MusicGraph | null = null;
  private muted = false;

  get ready() {
    return this.ctx !== null && this.ctx.state === "running";
  }

  /** Create the audio graph on the first user gesture. Safe to call repeatedly. */
  async unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.graph = new MusicGraph(this.ctx);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
    if (!this.muted) this.graph!.fadeIn(this.ctx.currentTime);
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (!this.ctx || !this.graph) return;
    if (muted) this.graph.fadeOut(this.ctx.currentTime);
    else this.graph.fadeIn(this.ctx.currentTime);
  }

  /** Called every frame with scroll progress and speed (progress per second). */
  update(p: number, velocity: number) {
    if (!this.ready || !this.graph) return;
    this.graph.tick(this.ctx!.currentTime, p, velocity);
  }

  dispose() {
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.graph = null;
  }
}

/** Render the music for a recorded scroll path (one progress value per video frame). */
export async function renderSoundtrack(progress: number[], fps: number) {
  const duration = progress.length / fps + 1;
  const ctx = new OfflineAudioContext(2, Math.ceil(44100 * duration), 44100);
  const graph = new MusicGraph(ctx);
  graph.fadeIn(0);
  progress.forEach((p, i) => {
    const prev = progress[Math.max(0, i - 1)];
    const next = progress[Math.min(progress.length - 1, i + 1)];
    const velocity = ((next - prev) / 2) * fps;
    graph.tick(i / fps, p, velocity, 1 / fps);
  });
  return ctx.startRendering();
}

/** 16-bit stereo WAV, base64 encoded, for handing out of the browser. */
export function wavBase64(buf: AudioBuffer) {
  const n = buf.length;
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const k = peak > 0 ? 0.8 / peak : 1;
  const out = new DataView(new ArrayBuffer(44 + n * 4));
  const str = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  out.setUint32(4, 36 + n * 4, true);
  str(8, "WAVEfmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 2, true);
  out.setUint32(24, buf.sampleRate, true);
  out.setUint32(28, buf.sampleRate * 4, true);
  out.setUint16(32, 4, true);
  out.setUint16(34, 16, true);
  str(36, "data");
  out.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    out.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i] * k)) * 32767, true);
    out.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i] * k)) * 32767, true);
  }
  const bytes = new Uint8Array(out.buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
