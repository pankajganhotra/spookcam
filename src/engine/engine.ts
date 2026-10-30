import type { EngineCommand, EngineStatus, Settings, VanishPhase } from '../shared/settings';
import type { DetectorBackend } from './detectors';
import { OneEuro } from './gl';
import { Renderer } from './renderer';

const PARTICLE_LIFE = 2.6;
const CLOAK_LIFE = 0.4;
/** Landmarks are kept this long through a dropped detection to avoid paint flicker. */
const FACE_HOLD_MS = 160;
/** Every Nth frame runs segmentation purely to keep learning the background. */
const LEARN_EVERY = 3;

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

  constructor(detectors: DetectorBackend, settings: Settings, onStatus?: (s: EngineStatus) => void) {
    this.settings = settings;
    this.detectors = detectors;
    if (onStatus) this.statusTimer = setInterval(() => onStatus(this.status()), 500);
    this.warmUp();
  }

  setSettings(s: Settings) {
    this.settings = s;
    if (!s.enabled) this.timeline = { from: 0, dir: 0, start: 0 };
    this.warmUp();
  }

  /** Starts model downloads before they are needed so effects appear without a hitch. */
  private warmUp() {
    if (!this.settings.enabled) return;
    this.detectors.warm({ mask: true, face: this.settings.face !== 'none' });
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
    return {
      process: (f) => p.process(f),
      close: () => {
        p.dispose();
        this.pipelines.delete(p);
      },
    };
  }

  status(): EngineStatus {
    let fps = 0, coverage = 0, faces = 0;
    for (const p of this.pipelines) {
      fps = Math.max(fps, p.fps);
      coverage = Math.max(coverage, p.coverage);
      faces = Math.max(faces, p.faceCount);
    }
    return {
      cameras: this.pipelines.size,
      fps,
      backgroundCoverage: coverage,
      phase: this.phase(),
      faces,
      loading: this.detectors.loading,
      error: this.error ?? this.detectors.error,
    };
  }

  dispose() {
    clearInterval(this.statusTimer);
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
  fps = 0;
  faceCount = 0;

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
    const needFace = s.face !== 'none';
    const needMask = s.backdrop !== 'none' || s.ghost || t > 0;
    const graded = s.tint !== 'none' || s.vignette > 0 || s.grain > 0 || s.flicker > 0 || s.glitch > 0 || s.fog > 0;
    const active = needFace || needMask || graded;
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
      const found = this.engine.detectors.detect(frame, { face: needFace && active, mask: needMask || learn, maxFaces: s.multiFace ? 3 : 1 });
      if (found.mask) {
        r.updateMask(found.mask);
        r.learnPlate();
      }
      if (!active) return null;

      const faces = needFace ? this.trackFaces(found.faces, frame.displayWidth, now) : [];
      const snapshot = this.snapGeneration !== this.engine.snapGeneration;
      this.snapGeneration = this.engine.snapGeneration;
      const dir = this.engine.phase(now) === 'returning';
      r.render({
        settings: s,
        faces,
        vanish: { t, duration: s.vanishDuration, life: this.engine.life, live: dir },
        time: now / 1000,
        snapshot,
      });
      return new VideoFrame(r.canvas, { timestamp: frame.timestamp, duration: frame.duration ?? undefined, alpha: 'discard' });
    } catch (err) {
      console.error('[SpookCam] frame failed; passing camera through', err);
      this.engine.error = String((err as Error)?.message ?? err);
      this.broken = true;
      return null;
    }
  }

  /** Smooths landmarks per face slot and bridges brief detection dropouts. */
  private trackFaces(found: Float32Array[] | null, width: number, now: number): Float32Array[] {
    if (!found) return [];
    if (!found.length) {
      if (now - this.lastFaceAt > FACE_HOLD_MS) {
        this.lastFaces = [];
        this.faceCount = 0;
        for (const f of this.filters) f.reset();
      }
      return this.lastFaces;
    }
    let faces = found;
    if (!this.engine.settings.multiFace) faces = [faces.reduce((a, b) => (faceExtent(b) > faceExtent(a) ? b : a))];
    // Stable slot order (left to right by nose tip) so each slot's filter follows one person.
    faces = [...faces].sort((a, b) => a[2] - b[2]);
    const tSec = now / 1000;
    const out = faces.map((lm, i) => (this.filters[i] ??= new OneEuro(1.2, 0.012)).filter(lm, tSec, width).slice());
    for (let i = faces.length; i < this.filters.length; i++) this.filters[i].reset();
    this.lastFaces = out;
    this.lastFaceAt = now;
    this.faceCount = out.length;
    return out;
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
