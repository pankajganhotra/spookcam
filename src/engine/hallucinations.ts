// Random "hallucinations": short, scary distortions that strike at unpredictable times.
// The director only decides *when* and *how much*; the composite/post shaders do the warping.

export type HallucinationKind = 'jaw' | 'eyes' | 'melt' | 'twitch' | 'echo' | 'figure' | 'flash' | 'jumpscare';

interface Event {
  kind: HallucinationKind;
  start: number;
  dur: number;
  seed: number;
}

export interface HallucinationState {
  /** 0..1 strengths. */
  jaw: number;
  eyes: number;
  melt: number;
  echo: number;
  flash: number;
  /** Whole-body jerk offset in uv units. */
  jerk: [number, number];
  /** Shadow figure: x position (uv), opacity, height scale. */
  figure: [number, number, number];
  /** Jump scare: zoom into the face (0..1), black void eyes/mouth + pallor, lights out, camera shake (uv). */
  zoom: number;
  voids: number;
  blackout: number;
  shake: [number, number];
  /** Anything warping the body (needs the clean background behind it). */
  active: boolean;
}

const DURATION: Record<HallucinationKind, number> = { jaw: 2.4, eyes: 2.2, melt: 2.8, twitch: 0.9, echo: 3.2, figure: 6, flash: 0.22, jumpscare: 1.5 };
const WEIGHT: Record<HallucinationKind, number> = { jaw: 3, eyes: 2, melt: 2, twitch: 3, echo: 2, figure: 2, flash: 1.5, jumpscare: 1.5 };

const rand = (seed: number) => {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
/** Attack / hold / release envelope over 0..1 of the event's life. */
const envelope = (p: number, attack: number, release: number) => smooth(0, attack, p) * (1 - smooth(1 - release, 1, p));

export class Hallucinations {
  private events: Event[] = [];
  private nextAt = 0;
  private seed = 1;

  /** Schedules new events; `intensity` 0 disables random scares (manual ones still play). */
  tick(nowSec: number, intensity: number) {
    this.events = this.events.filter((e) => nowSec - e.start < e.dur);
    if (intensity <= 0) {
      this.nextAt = 0;
      return;
    }
    if (!this.nextAt) this.nextAt = nowSec + 2 + 4 * Math.random();
    if (nowSec < this.nextAt) return;
    this.spawn(nowSec, this.pick());
    // Strong settings sometimes stack a second effect for a nastier moment.
    if (Math.random() < intensity * 0.35) this.spawn(nowSec + 0.3, this.pick());
    this.nextAt = nowSec + (4 + 10 * Math.random()) / (0.35 + intensity);
  }

  /** "Scare now": your own face lunges at the camera. */
  scare(nowSec: number) {
    this.spawn(nowSec, 'jumpscare');
  }

  private pick(): HallucinationKind {
    const kinds = Object.keys(WEIGHT) as HallucinationKind[];
    const total = kinds.reduce((a, k) => a + WEIGHT[k], 0);
    let r = Math.random() * total;
    for (const k of kinds) if ((r -= WEIGHT[k]) <= 0) return k;
    return 'jaw';
  }

  spawn(start: number, kind: HallucinationKind) {
    if (this.events.some((e) => e.kind === kind)) return;
    this.events.push({ kind, start, dur: DURATION[kind], seed: this.seed++ });
  }

  state(nowSec: number): HallucinationState {
    const s: HallucinationState = { jaw: 0, eyes: 0, melt: 0, echo: 0, flash: 0, jerk: [0, 0], figure: [0, 0, 1], zoom: 0, voids: 0, blackout: 0, shake: [0, 0], active: false };
    for (const e of this.events) {
      const p = (nowSec - e.start) / e.dur;
      if (p < 0 || p > 1) continue;
      switch (e.kind) {
        case 'jaw':
          s.jaw = Math.max(s.jaw, envelope(p, 0.18, 0.25));
          break;
        case 'eyes':
          s.eyes = Math.max(s.eyes, envelope(p, 0.12, 0.3));
          break;
        case 'melt':
          s.melt = Math.max(s.melt, envelope(p, 0.4, 0.2));
          break;
        case 'echo':
          s.echo = Math.max(s.echo, envelope(p, 0.15, 0.3));
          break;
        case 'flash':
          s.flash = Math.max(s.flash, 1 - p);
          break;
        case 'twitch': {
          // A few violent snaps, each held for ~70 ms.
          const step = Math.floor((nowSec - e.start) / 0.07);
          const amp = 0.035 * envelope(p, 0.05, 0.3);
          s.jerk = [(rand(e.seed * 31 + step) - 0.5) * 2 * amp, (rand(e.seed * 17 + step) - 0.5) * 1.2 * amp];
          break;
        }
        case 'jumpscare': {
          const t = nowSec - e.start;
          // 0–0.1 s lights out · 0.1–0.28 s lunge · hold and shudder · 1.0–1.25 s snap back · flicker.
          const lunge = smooth(0.1, 0.28, t) * (1 - smooth(1.0, 1.25, t));
          s.blackout = Math.max(s.blackout, t < 0.1 ? 1 : t > 1.27 && t < 1.34 ? 0.85 : 0);
          s.zoom = Math.max(s.zoom, lunge);
          s.voids = Math.max(s.voids, lunge);
          s.jaw = Math.max(s.jaw, 1.5 * lunge);
          s.eyes = Math.max(s.eyes, 0.6 * lunge);
          if (t > 0.1 && t < 0.16) s.flash = Math.max(s.flash, 1);
          const step = Math.floor(t / 0.03);
          const amp = 0.018 * lunge;
          s.shake = [(rand(e.seed * 13 + step) - 0.5) * 2 * amp, (rand(e.seed * 29 + step) - 0.5) * 2 * amp];
          break;
        }
        case 'figure': {
          const side = rand(e.seed) < 0.5 ? -1 : 1;
          const x = 0.5 + side * (0.24 + 0.16 * rand(e.seed + 3));
          // Fades in slowly, lingers, then is simply gone.
          s.figure = [x, envelope(p, 0.35, 0.08), 0.9 + 0.25 * rand(e.seed + 5)];
          break;
        }
      }
    }
    s.active = s.jaw > 0 || s.eyes > 0 || s.melt > 0 || s.echo > 0 || s.jerk[0] !== 0 || s.figure[1] > 0 || s.zoom > 0 || s.blackout > 0;
    return s;
  }
}
