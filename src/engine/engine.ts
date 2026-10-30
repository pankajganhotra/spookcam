import type { EngineCommand, EngineStatus, Settings, VanishPhase } from '../shared/settings';
import { BLENDSHAPES, type DetectorBackend } from './detectors';
import { OneEuro } from './gl';
import { Hallucinations, type HallucinationKind } from './hallucinations';
import { buildClaws, Magic } from './magic';
import { Renderer } from './renderer';
import { Sfx, type SfxKind } from './sfx';
import { SnapDetector } from './snap-detector';

const PARTICLE_LIFE = 2.6;
const CLOAK_LIFE = 0.4;
/** Landmarks are kept this long through a dropped detection to avoid paint flicker. */
const FACE_HOLD_MS = 160;
/** Every Nth frame runs segmentation purely to keep learning the background. */
const LEARN_EVERY = 3;

/** Supplies a microphone track the engine may own and stop (a clone, or its own capture). */
export type AudioProvider = () => Promise<MediaStreamTrack | null>;

/** Test hook: lets the E2E suite fake expressions and gestures it can't perform on a photo. */
type Force = { jawOpen?: number; mouthPucker?: number; gesture?: 'fist' | 'palm' | 'point'; hallucination?: HallucinationKind };
const force = () => (globalThis as { __spookcamForce?: Force }).__spookcamForce;

export interface FrameProcessor {
  /** Returns a processed frame, or null to pass the input through untouched. */
  process(frame: VideoFrame): VideoFrame | null;
  close(): void;
}

export class SpookEngine {
  settings: Settings;
  readonly detectors: DetectorBackend;
  private pipelines = new Set<Pipeline>();
  private timeline = { from: 0, dir: 0, start: 0 };
  snapGeneration = 0;
  error?: string;
  private statusTimer?: ReturnType<typeof setInterval>;
  readonly hall = new Hallucinations();
  private audioProvider?: AudioProvider;
  private snap?: { detector: SnapDetector; track: MediaStreamTrack };
  private listening: NonNullable<EngineStatus['listening']> = 'off';
  private heardSnapAt?: number;
  private listenGeneration = 0;
  private audioCtx?: AudioContext;
  private sfx?: Sfx;
  /** Gain feeding the outgoing call microphone mix (0 unless sounds === 'call'). */
  private callSend?: GainNode;
  private callBus?: AudioNode;

  constructor(detectors: DetectorBackend, settings: Settings, onStatus?: (s: EngineStatus) => void) {
    this.settings = settings;
    this.detectors = detectors;
    this.hall.onSpawn = (kind) => this.sound(kind);
    if (onStatus) this.statusTimer = setInterval(() => onStatus(this.status()), 500);
    this.warmUp();
  }

  setSettings(s: Settings) {
    this.settings = s;
    if (!s.enabled) this.timeline = { from: 0, dir: 0, start: 0 };
    this.warmUp();
    this.syncListening();
  }

  /** Routes scare sounds into the outgoing call microphone (set up by the page hook). */
  setCallMixer(ctx: AudioContext, bus: AudioNode) {
    this.sfx?.bus.disconnect();
    this.sfx = undefined;
    this.audioCtx = ctx;
    this.callBus = bus;
  }

  private sound(kind: SfxKind) {
    const s = this.settings;
    if (!s.enabled || s.sounds === 'off' || this.pipelines.size === 0) return;
    try {
      if (!this.sfx) {
        const ctx = (this.audioCtx ??= new AudioContext());
        this.sfx = new Sfx(ctx);
        this.sfx.bus.connect(ctx.destination);
        if (this.callBus) {
          this.callSend = ctx.createGain();
          this.sfx.bus.connect(this.callSend).connect(this.callBus);
        }
      }
      this.sfx.volume = s.soundVolume;
      if (this.callSend) this.callSend.gain.value = s.sounds === 'call' ? 1 : 0;
      this.sfx.play(kind);
    } catch (err) {
      console.warn('[SpookCam] sound failed', err);
    }
  }

  /** (Re)sets where the microphone comes from; restarts any running listener. */
  setAudioProvider(provider: AudioProvider | undefined) {
    this.audioProvider = provider;
    this.stopListening();
    this.syncListening();
  }

  private stopListening() {
    this.listenGeneration++;
    this.snap?.detector.close();
    this.snap?.track.stop();
    this.snap = undefined;
    this.listening = 'off';
  }

  /** Opens or closes the snap listener to match settings and whether a camera is live. */
  private syncListening() {
    const s = this.settings;
    const want = s.enabled && s.snapSound && this.pipelines.size > 0 && !!this.audioProvider;
    if (!want) {
      this.stopListening();
      return;
    }
    if (this.snap || this.listening === 'starting' || this.listening === 'blocked') return;
    this.listening = 'starting';
    const generation = this.listenGeneration;
    this.audioProvider!()
      .then((track) => {
        if (generation !== this.listenGeneration) {
          track?.stop(); // superseded while we were waiting
          return;
        }
        if (!track) {
          this.listening = 'blocked';
          return;
        }
        const detector = new SnapDetector(
          track,
          () => {
            this.heardSnapAt = Date.now();
            this.command('snap');
          },
          () => this.settings.snapSensitivity,
        );
        this.snap = { detector, track };
        this.listening = 'on';
      })
      .catch((err) => {
        console.warn('[SpookCam] microphone unavailable for snap detection', err);
        this.listening = 'blocked';
      });
  }

  /** Starts model downloads before they are needed so effects appear without a hitch. */
  private warmUp() {
    if (!this.settings.enabled) return;
    const s = this.settings;
    this.detectors.warm({ mask: true, face: s.face !== 'none' || s.magic || s.hallucinate > 0, hands: s.magic || s.claws || s.backdrop !== 'none' || s.ghost });
  }

  get life() {
    return this.settings.vanishStyle === 'cloak' ? CLOAK_LIFE : PARTICLE_LIFE;
  }

  get total() {
    return this.settings.vanishDuration + this.life;
  }

  vanishT(now = performance.now()) {
    const { from, dir, start } = this.timeline;
    return Math.min(this.total, Math.max(0, from + (dir * (now - start)) / 1000));
  }

  phase(now = performance.now()): VanishPhase {
    const t = this.vanishT(now);
    if (this.timeline.dir > 0) return t >= this.total ? 'gone' : 'vanishing';
    if (this.timeline.dir < 0) return t <= 0 ? 'present' : 'returning';
    return 'present';
  }

  command(cmd: EngineCommand) {
    const now = performance.now();
    const phase = this.phase(now);
    const go = (dir: 1 | -1) => {
      const from = this.vanishT(now);
      if (dir > 0 && from === 0) this.snapGeneration++;
      this.sound(dir > 0 ? 'vanish' : 'return');
      this.timeline = { from, dir, start: now };
    };
    switch (cmd) {
      case 'snap':
        go(phase === 'present' || phase === 'returning' ? 1 : -1);
        break;
      case 'vanish':
        if (phase === 'present' || phase === 'returning') go(1);
        break;
      case 'reappear':
        if (phase === 'gone' || phase === 'vanishing') go(-1);
        break;
      case 'relearn-background':
        for (const p of this.pipelines) p.resetBackground();
        break;
      case 'scare':
        this.hall.scare(now / 1000);
        break;
    }
  }

  /** Auto-return after the configured delay. */
  tick(now: number) {
    const { autoReturn } = this.settings;
    if (!autoReturn || this.timeline.dir <= 0) return;
    const goneAt = this.timeline.start + ((this.total - this.timeline.from) * 1000);
    if (now - goneAt > autoReturn * 1000) this.command('reappear');
  }

  createPipeline(): FrameProcessor {
    const p = new Pipeline(this);
    this.pipelines.add(p);
    this.syncListening();
    return {
      process: (f) => p.process(f),
      close: () => {
        p.dispose();
        this.pipelines.delete(p);
        this.syncListening();
      },
    };
  }

  status(): EngineStatus {
    let fps = 0, coverage = 0, faces = 0, hands = 0;
    let gestures: string[] = [];
    for (const p of this.pipelines) {
      fps = Math.max(fps, p.fps);
      coverage = Math.max(coverage, p.coverage);
      faces = Math.max(faces, p.faceCount);
      if (p.handCount >= hands) {
        hands = p.handCount;
        gestures = p.gestures;
      }
    }
    return {
      cameras: this.pipelines.size,
      fps,
      backgroundCoverage: coverage,
      phase: this.phase(),
      faces,
      loading: this.detectors.loading,
      error: this.error ?? this.detectors.error,
      listening: this.snap && !this.snap.detector.running ? 'starting' : this.listening,
      hands,
      gestures,
      heardSnapAt: this.heardSnapAt,
    };
  }

  dispose() {
    clearInterval(this.statusTimer);
    this.audioProvider = undefined;
    this.syncListening();
    for (const p of this.pipelines) p.dispose();
    this.pipelines.clear();
    this.detectors.close();
  }
}

function faceExtent(lm: Float32Array) {
  let minX = 1, maxX = 0;
  for (let i = 0; i < lm.length; i += 2) {
    if (lm[i] < minX) minX = lm[i];
    if (lm[i] > maxX) maxX = lm[i];
  }
  return maxX - minX;
}

class Pipeline {
  private renderer?: Renderer;
  private broken = false;
  private frameNo = 0;
  private snapGeneration = 0;
  private filters: OneEuro[] = [];
  private lastFaces: Float32Array[] = [];
  private lastFaceAt = 0;
  private fpsCount = 0;
  private fpsStart = performance.now();
  private pendingReset = false;
  private handFilters: OneEuro[] = [];
  private lastHands: Float32Array[] = [];
  private lastHandAt = 0;
  private magic = new Magic();
  private lastFrameAt = 0;
  fps = 0;
  faceCount = 0;
  handCount = 0;

  get gestures(): string[] {
    return this.engine.settings.magic ? this.magic.gestures : [];
  }

  constructor(private engine: SpookEngine) {
    this.snapGeneration = engine.snapGeneration;
  }

  get coverage() {
    return this.renderer?.coverage ?? 0;
  }

  resetBackground() {
    this.pendingReset = true;
  }

  process(frame: VideoFrame): VideoFrame | null {
    const s = this.engine.settings;
    if (!s.enabled || this.broken) return null;
    const now = performance.now();
    this.countFps(now);
    this.engine.tick(now);
    const t = this.engine.vanishT(now);
    const haunted = s.hallucinate > 0;
    // Hands are also tracked whenever the background is replaced, to keep them in the person mask.
    const needHands = s.magic || s.claws || s.backdrop !== 'none' || s.ghost;
    const needFace = s.face !== 'none' || s.magic || haunted;
    const needMask = s.backdrop !== 'none' || s.ghost || t > 0 || haunted;
    const graded = s.tint !== 'none' || s.vignette > 0 || s.grain > 0 || s.flicker > 0 || s.glitch > 0 || s.fog > 0;
    const active = needFace || needMask || graded || needHands || this.magic.busy;
    const nowSec = now / 1000;
    this.engine.hall.tick(nowSec, s.hallucinate);
    const forced = force();
    if (forced?.hallucination) {
      this.engine.hall.spawn(nowSec, forced.hallucination);
      delete forced.hallucination;
    }
    const hall = this.engine.hall.state(nowSec);
    const learn = ++this.frameNo % LEARN_EVERY === 0;
    if (!active && !learn) return null;

    try {
      const r = (this.renderer ??= new Renderer());
      if (!r.ready) return null;
      r.resize(frame.displayWidth, frame.displayHeight);
      r.uploadFrame(frame);
      if (this.pendingReset) {
        r.resetPlate();
        this.pendingReset = false;
      }
      const found = this.engine.detectors.detect(frame, { face: needFace && active, mask: needMask || learn, hands: needHands && active, maxFaces: s.multiFace ? 3 : 1 });
      const res: [number, number] = [frame.displayWidth, frame.displayHeight];
      const hands = needHands ? this.trackHands(found.hands, res[0], now) : [];
      if (found.mask) r.updateMask(found.mask);
      r.stampHands(hands, res[0], res[1]);
      if (found.mask) r.learnPlate();
      if (!active) return null;

      const { faces, blend } = needFace ? this.trackFaces(found.faces, found.blend, res[0], now) : { faces: [], blend: [] };
      const dt = this.lastFrameAt ? (now - this.lastFrameAt) / 1000 : 1 / 30;
      this.lastFrameAt = now;
      const f = force();
      if (f && blend[0]) {
        if (f.jawOpen !== undefined) blend[0][BLENDSHAPES.indexOf('jawOpen')] = f.jawOpen;
        if (f.mouthPucker !== undefined) blend[0][BLENDSHAPES.indexOf('mouthPucker')] = f.mouthPucker;
      }
      const magic = s.magic || this.magic.busy ? this.magic.update(dt, nowSec, res, faces, blend, hands, s.magic, f?.gesture) : undefined;
      const snapshot = this.snapGeneration !== this.engine.snapGeneration;
      this.snapGeneration = this.engine.snapGeneration;
      const dir = this.engine.phase(now) === 'returning';
      r.render({
        settings: s,
        faces,
        vanish: { t, duration: s.vanishDuration, life: this.engine.life, live: dir },
        time: nowSec,
        snapshot,
        hall,
        magic,
        claws: s.claws ? buildClaws(hands, res) : undefined,
      });
      return new VideoFrame(r.canvas, { timestamp: frame.timestamp, duration: frame.duration ?? undefined, alpha: 'discard' });
    } catch (err) {
      console.error('[SpookCam] frame failed; passing camera through', err);
      this.engine.error = String((err as Error)?.message ?? err);
      this.broken = true;
      return null;
    }
  }

  /** Smooths landmarks per face slot and bridges brief detection dropouts; keeps blendshapes paired. */
  private trackFaces(found: Float32Array[] | null, blend: Float32Array[] | null, width: number, now: number): { faces: Float32Array[]; blend: Float32Array[] } {
    if (!found) return { faces: [], blend: [] };
    if (!found.length) {
      if (now - this.lastFaceAt > FACE_HOLD_MS) {
        this.lastFaces = [];
        this.faceCount = 0;
        for (const f of this.filters) f.reset();
      }
      return { faces: this.lastFaces, blend: [] };
    }
    let pairs = found.map((lm, i) => ({ lm, b: blend?.[i] ?? new Float32Array(BLENDSHAPES.length) }));
    if (!this.engine.settings.multiFace) pairs = [pairs.reduce((a, c) => (faceExtent(c.lm) > faceExtent(a.lm) ? c : a))];
    // Stable slot order (left to right by nose tip) so each slot's filter follows one person.
    pairs.sort((a, c) => a.lm[2] - c.lm[2]);
    const tSec = now / 1000;
    const faces = pairs.map((p, i) => (this.filters[i] ??= new OneEuro(1.2, 0.012)).filter(p.lm, tSec, width).slice());
    for (let i = pairs.length; i < this.filters.length; i++) this.filters[i].reset();
    this.lastFaces = faces;
    this.lastFaceAt = now;
    this.faceCount = faces.length;
    return { faces, blend: pairs.map((p) => p.b) };
  }

  private trackHands(found: Float32Array[] | null, width: number, now: number): Float32Array[] {
    if (!found) return [];
    if (!found.length) {
      if (now - this.lastHandAt > FACE_HOLD_MS) {
        this.lastHands = [];
        this.handCount = 0;
        for (const f of this.handFilters) f.reset();
      }
      return this.lastHands;
    }
    const hands = [...found].sort((a, b) => a[0] - b[0]);
    const tSec = now / 1000;
    this.lastHands = hands.map((h, i) => (this.handFilters[i] ??= new OneEuro(1.6, 0.02)).filter(h, tSec, width).slice());
    for (let i = hands.length; i < this.handFilters.length; i++) this.handFilters[i].reset();
    this.lastHandAt = now;
    this.handCount = this.lastHands.length;
    return this.lastHands;
  }

  private countFps(now: number) {
    this.fpsCount++;
    if (now - this.fpsStart >= 1000) {
      this.fps = Math.round((this.fpsCount * 1000) / (now - this.fpsStart));
      this.fpsCount = 0;
      this.fpsStart = now;
    }
  }

  dispose() {
    this.renderer?.dispose();
    this.renderer = undefined;
  }
}
