// Finger-snap detector. A snap is a loud, very short, broadband click: energy jumps far above
// the room's noise floor, most of it sits in high frequencies, it peaks within a few ms, and it
// dies away within ~50 ms. Speech, tones and music fail the high-frequency and decay tests;
// keyboard clicks are too quiet.

export const SNAP_BLOCK = 1024;
const SUB = 128;

/** Pure signal analysis over consecutive blocks — no WebAudio, so it can be unit-tested. */
export class SnapAnalyser {
  private floor = 1e-5;
  private pending: { peakE: number; blocks: number } | null = null;
  private cooldownUntil = -Infinity;

  /** `sensitivity` 0..1: higher reacts to quieter snaps. Returns true when a snap is confirmed. */
  analyse(x: Float32Array, nowMs: number, sensitivity: number): boolean {
    let e = 0, hf = 0, peak = 0, maxSub = 0, sub = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      e += v * v;
      const d = i ? v - x[i - 1] : 0;
      hf += d * d;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sub += v * v;
      if ((i + 1) % SUB === 0) {
        maxSub = Math.max(maxSub, sub / SUB);
        sub = 0;
      }
    }
    e /= x.length;
    hf /= x.length;

    if (this.pending) {
      // Confirm: a snap decays fast; anything still loud after ~3 blocks is speech or music.
      this.pending.blocks++;
      if (e < this.pending.peakE * 0.3) {
        this.pending = null;
        this.cooldownUntil = nowMs + 1200;
        return true;
      }
      if (this.pending.blocks >= 3) this.pending = null;
      else this.pending.peakE = Math.max(this.pending.peakE, e);
      return false;
    }

    const ratio = 70 - 55 * sensitivity; // energy above the noise floor: ≈18 dB … 12 dB
    const minPeak = 0.18 - 0.14 * sensitivity;
    const loud = e > this.floor * ratio && peak > minPeak;
    const bright = hf / Math.max(e, 1e-12) > 0.55; // white noise ≈ 2, voice ≈ 0.1–0.3
    const impulsive = maxSub / Math.max(e, 1e-12) > 2.5;
    if (loud && bright && impulsive && nowMs > this.cooldownUntil) {
      this.pending = { peakE: e, blocks: 0 };
      return false;
    }
    // Track the room's noise floor; rise slowly so talking doesn't desensitise us.
    const k = e > this.floor ? 0.01 : 0.08;
    this.floor = Math.max(1e-7, this.floor * (1 - k) + e * k);
    return false;
  }
}

/** Wires a microphone track into a SnapAnalyser. */
export class SnapDetector {
  private ctx: AudioContext;
  private node: ScriptProcessorNode;
  private source: MediaStreamAudioSourceNode;
  private analyser = new SnapAnalyser();
  private resumeOnGesture = () => void this.ctx.resume();

  constructor(
    track: MediaStreamTrack,
    onSnap: () => void,
    sensitivity: () => number,
  ) {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.source = this.ctx.createMediaStreamSource(new MediaStream([track]));
    // ScriptProcessor (not AudioWorklet) because worklet modules can be blocked by page CSP.
    this.node = this.ctx.createScriptProcessor(SNAP_BLOCK, 1, 1);
    this.node.onaudioprocess = (e) => {
      if (this.analyser.analyse(e.inputBuffer.getChannelData(0), performance.now(), sensitivity())) onSnap();
    };
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.source.connect(this.node);
    this.node.connect(mute);
    mute.connect(this.ctx.destination);
    // Autoplay policy may start us suspended until the user interacts with the page.
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
      window.addEventListener('pointerdown', this.resumeOnGesture, { capture: true });
      window.addEventListener('keydown', this.resumeOnGesture, { capture: true });
    }
  }

  get running() {
    return this.ctx.state === 'running';
  }

  close() {
    window.removeEventListener('pointerdown', this.resumeOnGesture, { capture: true });
    window.removeEventListener('keydown', this.resumeOnGesture, { capture: true });
    this.node.onaudioprocess = null;
    this.source.disconnect();
    this.node.disconnect();
    void this.ctx.close();
  }
}
