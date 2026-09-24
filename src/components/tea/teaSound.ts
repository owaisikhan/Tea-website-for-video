// Subtle scroll sounds, synthesised with Web Audio (no audio files):
// - a soft airy whoosh whose loudness follows scroll speed,
// - a quiet glass "ting" each time a new section arrives,
// - a gentle trickle while the tea is pouring.
// Browsers only allow audio after a tap, click or key press, so `unlock()`
// is called from the first such gesture.

const MASTER = 0.9;

export class TeaSound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private whooshGain!: GainNode;
  private whooshFilter!: BiquadFilterNode;
  private pourGain!: GainNode;
  private pourFilter!: BiquadFilterNode;
  private muted = false;
  private lastChime = 0;

  get ready() {
    return this.ctx !== null && this.ctx.state === "running";
  }

  /** Create the audio graph on the first user gesture. Safe to call repeatedly. */
  async unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.build(this.ctx);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(muted ? 0 : MASTER, this.ctx.currentTime, 0.15);
  }

  /**
   * Called every frame. `velocity` is scroll progress per second (a brisk
   * scroll is around 0.2); `flow` is 0..1 while tea pours.
   */
  update(velocity: number, flow: number) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const speed = Math.min(Math.abs(velocity) / 0.25, 1);
    this.whooshGain.gain.setTargetAtTime(speed * speed * 0.09, now, 0.12);
    this.whooshFilter.frequency.setTargetAtTime(380 + speed * 1300, now, 0.15);
    // Trickle: flicker the level and pitch a little so it sounds like water, not hiss.
    const flicker = 0.75 + Math.random() * 0.5;
    this.pourGain.gain.setTargetAtTime(flow * 0.05 * flicker, now, 0.05);
    this.pourFilter.frequency.setTargetAtTime(1900 + Math.random() * 1100, now, 0.04);
  }

  /** A soft glass tap. `index` picks a note so each section sounds a little different. */
  chime(index: number) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    if (now - this.lastChime < 0.35) return;
    this.lastChime = now;
    const notes = [1318.5, 1480, 1568, 1760, 1975.5, 2093, 2349.3];
    const f = notes[index % notes.length];
    // Inharmonic partials are what make a tap sound like glass rather than a bell.
    const partials: [number, number, number][] = [
      [1, 0.03, 1.6],
      [2.76, 0.012, 0.9],
      [5.4, 0.005, 0.5],
    ];
    for (const [ratio, gain, decay] of partials) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f * ratio;
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(gain, now + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, now + decay);
      osc.connect(g).connect(this.master);
      osc.start(now);
      osc.stop(now + decay + 0.05);
    }
  }

  dispose() {
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  private build(ctx: AudioContext) {
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : MASTER;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    this.master.connect(comp).connect(ctx.destination);

    // Two seconds of looping noise feeds both the whoosh and the trickle.
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    const whooshSrc = ctx.createBufferSource();
    whooshSrc.buffer = buf;
    whooshSrc.loop = true;
    this.whooshFilter = ctx.createBiquadFilter();
    this.whooshFilter.type = "bandpass";
    this.whooshFilter.Q.value = 0.7;
    this.whooshFilter.frequency.value = 400;
    this.whooshGain = ctx.createGain();
    this.whooshGain.gain.value = 0;
    whooshSrc.connect(this.whooshFilter).connect(this.whooshGain).connect(this.master);
    whooshSrc.start();

    const pourSrc = ctx.createBufferSource();
    pourSrc.buffer = buf;
    pourSrc.loop = true;
    pourSrc.playbackRate.value = 0.8;
    this.pourFilter = ctx.createBiquadFilter();
    this.pourFilter.type = "bandpass";
    this.pourFilter.Q.value = 2.5;
    this.pourFilter.frequency.value = 2200;
    const pourLow = ctx.createBiquadFilter();
    pourLow.type = "lowpass";
    pourLow.frequency.value = 4000;
    this.pourGain = ctx.createGain();
    this.pourGain.gain.value = 0;
    pourSrc.connect(this.pourFilter).connect(pourLow).connect(this.pourGain).connect(this.master);
    pourSrc.start();
  }
}
