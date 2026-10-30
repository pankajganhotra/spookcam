// Procedural horror sound effects (Web Audio only — no audio files, nothing fetched).
// Every sound is built from oscillators and filtered noise at the moment it plays.

export type SfxKind = 'jumpscare' | 'jaw' | 'eyes' | 'melt' | 'twitch' | 'echo' | 'figure' | 'flash' | 'vanish' | 'return';

export class Sfx {
  private noise?: AudioBuffer;
  readonly bus: GainNode;
  private comp: DynamicsCompressorNode;

  constructor(private ctx: AudioContext) {
    // Glue compressor → fast limiter → tanh soft clip: loud and punchy, never clipping a call.
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.ratio.value = 6;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;
    const clip = ctx.createWaveShaper();
    const curve = new Float32Array(2048);
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / (curve.length - 1)) * 2 - 1) * 1.2) / Math.tanh(1.2) * 0.95;
    clip.curve = curve;
    this.bus = ctx.createGain();
    this.comp.connect(limiter).connect(clip).connect(this.bus);
  }

  set volume(v: number) {
    this.bus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  private white(): AudioBuffer {
    if (!this.noise) {
      const sr = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, sr * 2, sr);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return this.noise;
  }

  private noiseSrc(t: number, dur: number) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.white();
    s.loop = true;
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur);
    return s;
  }

  private osc(type: OscillatorType, freq: number, t: number, dur: number) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.start(t);
    o.stop(t + dur);
    return o;
  }

  /** Gain node with an attack / exponential-decay envelope. */
  private env(t: number, peak: number, attack: number, decay: number, hold = 0) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + decay);
    return g;
  }

  private filter(type: BiquadFilterType, freq: number, q = 1) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  private chain(...nodes: AudioNode[]) {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    nodes[nodes.length - 1].connect(this.comp);
  }

  private distortion(amount: number) {
    const ws = this.ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
    }
    ws.curve = curve;
    return ws;
  }

  play(kind: SfxKind) {
    if (this.ctx.state === 'suspended' && typeof OfflineAudioContext !== 'undefined' && !(this.ctx instanceof OfflineAudioContext)) {
      void this.ctx.resume().catch(() => {});
    }
    const t = this.ctx.currentTime + 0.01;
    switch (kind) {
      case 'jumpscare': return this.stinger(t + 0.1); // lands with the lunge, after the lights cut
      case 'flash': return this.hit(t, 0.5);
      case 'jaw': return this.moan(t, 140, 70, 2.2);
      case 'eyes': return this.screech(t, 2.0);
      case 'melt': return this.melt(t);
      case 'twitch': return this.crackles(t, 5, 0.9);
      case 'echo': return this.whisper(t, 3.0);
      case 'figure': return this.drone(t, 6);
      case 'vanish': return this.whoosh(t, false);
      case 'return': return this.whoosh(t, true);
    }
  }

  // ── Recipes ──

  /** Dissonant orchestral hit + scream + sub boom + metallic screech. */
  private stinger(t: number) {
    const cluster = [110, 116.5, 164.8, 174.6, 233.1, 246.9];
    const lp = this.filter('lowpass', 4000, 0.7);
    lp.frequency.setValueAtTime(4000, t);
    lp.frequency.exponentialRampToValueAtTime(700, t + 1.2);
    const g = this.env(t, 0.3, 0.006, 1.5);
    lp.connect(g);
    this.chain(g);
    for (const f of cluster) {
      const o = this.osc('sawtooth', f * 2, t, 1.6);
      o.detune.value = (Math.random() - 0.5) * 30;
      o.connect(lp);
    }
    // Scream: noise through a sweeping vocal formant, overdriven.
    const n = this.noiseSrc(t, 1.4);
    const f1 = this.filter('bandpass', 900, 9);
    f1.frequency.setValueAtTime(900, t);
    f1.frequency.exponentialRampToValueAtTime(2600, t + 0.18);
    f1.frequency.exponentialRampToValueAtTime(1500, t + 1.2);
    const f2 = this.filter('bandpass', 3000, 6);
    const sg = this.env(t, 1.2, 0.03, 1.1);
    n.connect(f1);
    n.connect(f2);
    const mix = this.ctx.createGain();
    f1.connect(mix);
    f2.connect(mix);
    this.chain(mix, this.distortion(6), sg);
    // Sub boom.
    const boom = this.osc('sine', 90, t, 1.0);
    boom.frequency.exponentialRampToValueAtTime(32, t + 0.7);
    this.chain(boom, this.env(t, 0.8, 0.004, 0.9));
    // Metallic screech.
    const sc = this.osc('sine', 3300, t, 1.0);
    const lfo = this.osc('sine', 37, t, 1.0);
    const depth = this.ctx.createGain();
    depth.gain.value = 500;
    lfo.connect(depth).connect(sc.frequency);
    this.chain(sc, this.env(t, 0.12, 0.01, 0.8));
  }

  private hit(t: number, level: number) {
    this.chain(this.noiseSrc(t, 0.4), this.filter('lowpass', 2500), this.env(t, level, 0.002, 0.25));
    const o = this.osc('sine', 70, t, 0.4);
    o.frequency.exponentialRampToValueAtTime(35, t + 0.3);
    this.chain(o, this.env(t, level * 1.4, 0.002, 0.35));
  }

  /** Demonic moan: a sliding sawtooth through two vowel formants with a wobble. */
  private moan(t: number, from: number, to: number, dur: number) {
    const o = this.osc('sawtooth', from, t, dur + 0.5);
    o.frequency.exponentialRampToValueAtTime(to, t + dur);
    const vib = this.osc('sine', 5.5, t, dur + 0.5);
    const vd = this.ctx.createGain();
    vd.gain.value = 4;
    vib.connect(vd).connect(o.frequency);
    const g = this.env(t, 0.55, 0.25, 0.8, dur - 0.6);
    for (const [f, q] of [[700, 6], [1150, 7], [2400, 9]] as const) {
      const bp = this.filter('bandpass', f, q);
      o.connect(bp);
      bp.connect(g);
    }
    this.chain(g, this.distortion(3));
  }

  /** Violin-like screech with vibrato and tremolo. */
  private screech(t: number, dur: number) {
    const o = this.osc('sawtooth', 1750, t, dur);
    o.frequency.linearRampToValueAtTime(2250, t + dur);
    const vib = this.osc('sine', 7, t, dur);
    const vd = this.ctx.createGain();
    vd.gain.value = 35;
    vib.connect(vd).connect(o.frequency);
    const trem = this.ctx.createGain();
    const tl = this.osc('sine', 11, t, dur);
    const td = this.ctx.createGain();
    td.gain.value = 0.4;
    tl.connect(td).connect(trem.gain);
    this.chain(o, this.filter('highpass', 1200), trem, this.env(t, 0.16, 0.08, 0.5, dur - 0.6));
  }

  private melt(t: number) {
    this.moan(t, 95, 42, 2.6);
    for (let i = 0; i < 6; i++) {
      const at = t + 0.3 + i * 0.35 + Math.random() * 0.15;
      const o = this.osc('sine', 1100 + Math.random() * 500, at, 0.12);
      o.frequency.exponentialRampToValueAtTime(320, at + 0.09);
      this.chain(o, this.env(at, 0.18, 0.003, 0.09));
    }
  }

  private crackles(t: number, count: number, level: number) {
    for (let i = 0; i < count; i++) {
      const at = t + i * 0.07 * (0.6 + Math.random());
      this.chain(this.noiseSrc(at, 0.06), this.filter('highpass', 1800), this.distortion(20), this.env(at, level * 0.4, 0.001, 0.04));
    }
  }

  /** Breathy whispers: filtered noise chopped into syllables, drifting between ears. */
  private whisper(t: number, dur: number) {
    const n = this.noiseSrc(t, dur);
    const bp = this.filter('bandpass', 3200, 2.5);
    const syll = this.ctx.createGain();
    syll.gain.value = 0;
    const lfo = this.osc('square', 6.5, t, dur);
    const ld = this.ctx.createGain();
    ld.gain.value = 0.5;
    lfo.connect(ld).connect(syll.gain);
    const pan = this.ctx.createStereoPanner();
    const pl = this.osc('sine', 0.4, t, dur);
    pl.connect(pan.pan);
    this.chain(n, bp, syll, pan, this.env(t, 0.9, 0.4, 0.8, dur - 1.2));
  }

  /** Beating sub drone with a slow breath — something is standing behind you. */
  private drone(t: number, dur: number) {
    const g = this.env(t, 0.12, 2.0, 1.2, dur - 3.2);
    for (const f of [55, 58.3, 110.4]) this.osc('sine', f, t, dur).connect(g);
    this.chain(g);
    const n = this.noiseSrc(t, dur);
    const bp = this.filter('bandpass', 450, 3);
    const breath = this.ctx.createGain();
    breath.gain.value = 0;
    const lfo = this.osc('sine', 0.35, t, dur);
    const ld = this.ctx.createGain();
    ld.gain.value = 0.3;
    lfo.connect(ld).connect(breath.gain);
    this.chain(n, bp, breath, this.env(t, 1, 1.5, 1, dur - 2.6));
  }

  /** Dust whoosh; reversed (rising into a sharp stop) for the return. */
  private whoosh(t: number, reverse: boolean) {
    const dur = 2.6;
    const n = this.noiseSrc(t, dur + 0.2);
    const bp = this.filter('bandpass', reverse ? 3200 : 380, 1.4);
    bp.frequency.setValueAtTime(reverse ? 3200 : 380, t);
    bp.frequency.exponentialRampToValueAtTime(reverse ? 380 : 3200, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    if (reverse) {
      g.gain.exponentialRampToValueAtTime(0.5, t + dur - 0.05);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
    } else {
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.35);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    }
    this.chain(n, bp, g);
    this.crackles(t + (reverse ? 1.6 : 0.2), 8, 0.35);
  }
}

/** Renders a sound offline (for tests): returns peak and RMS of the result. */
export async function measure(kind: SfxKind, sampleRate = 44100): Promise<{ peak: number; rms: number; seconds: number }> {
  const seconds = kind === 'figure' ? 6.5 : 3.5;
  const ctx = new OfflineAudioContext(2, sampleRate * seconds, sampleRate) as unknown as AudioContext;
  const sfx = new Sfx(ctx);
  sfx.bus.connect(ctx.destination);
  sfx.play(kind);
  const buf = await (ctx as unknown as OfflineAudioContext).startRendering();
  let peak = 0, sum = 0;
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    peak = Math.max(peak, Math.abs(d[i]));
    sum += d[i] * d[i];
  }
  return { peak, rms: Math.sqrt(sum / d.length), seconds };
}

