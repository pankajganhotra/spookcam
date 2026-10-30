// Gesture magic: reads mouth blendshapes and hand poses, runs a small CPU particle system and
// emits draw lists (particles, flames, candle bodies, claws, lights) for the renderer.
import { BLENDSHAPES } from './detectors';

type V2 = [number, number];

const JAW = BLENDSHAPES.indexOf('jawOpen');
const PUCKER = BLENDSHAPES.indexOf('mouthPucker');
const FUNNEL = BLENDSHAPES.indexOf('mouthFunnel');

const MAX_PARTICLES = 1400;
/** Finger chains (MCP, PIP, DIP, TIP) in MediaPipe hand landmark indices. */
const FINGERS = [
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
];
const THUMB = [2, 3, 4];

export type Gesture = 'none' | 'fist' | 'palm' | 'point';

export interface Flame {
  /** Base center (px), size (px), kind 0 = candle/finger flame, 1 = fireball. */
  x: number;
  y: number;
  size: number;
  kind: 0 | 1;
  seed: number;
}

export interface Light {
  x: number;
  y: number;
  radius: number;
  intensity: number;
}

export interface MagicFrame {
  /** Interleaved x, y (uv), size (px), r, g, b, a — premultiplied. */
  smoke: Float32Array;
  smokeCount: number;
  fire: Float32Array;
  fireCount: number;
  flames: Flame[];
  lights: Light[];
}

export interface StripGeometry {
  data: Float32Array;
  count: number;
}

const rnd = Math.random;
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

const enum P {
  Fire,
  Smoke,
  Spark,
}

/** Per-hand gesture with a few frames of hysteresis so effects don't flicker. */
class GestureTracker {
  private candidate: Gesture = 'none';
  private count = 0;
  current: Gesture = 'none';
  update(g: Gesture) {
    if (g === this.current) {
      this.count = 0;
      return this.current;
    }
    if (g === this.candidate) this.count++;
    else {
      this.candidate = g;
      this.count = 1;
    }
    if (this.count >= (g === 'none' ? 6 : 3)) this.current = g;
    return this.current;
  }
}

export function classifyHand(h: Float32Array, res: V2): Gesture {
  const px = (i: number): V2 => [h[i * 2] * res[0], h[i * 2 + 1] * res[1]];
  const d = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const wrist = px(0);
  const extended = FINGERS.map(([, pip, , tip]) => d(wrist, px(tip)) > d(wrist, px(pip)) * 1.2);
  const n = extended.filter(Boolean).length;
  if (n === 0) return 'fist';
  if (n === 4) return 'palm';
  if (extended[0] && n === 1) return 'point';
  return 'none';
}

export class Magic {
  private x = new Float32Array(MAX_PARTICLES);
  private y = new Float32Array(MAX_PARTICLES);
  private vx = new Float32Array(MAX_PARTICLES);
  private vy = new Float32Array(MAX_PARTICLES);
  private age = new Float32Array(MAX_PARTICLES);
  private life = new Float32Array(MAX_PARTICLES);
  private s0 = new Float32Array(MAX_PARTICLES);
  private s1 = new Float32Array(MAX_PARTICLES);
  private kind = new Uint8Array(MAX_PARTICLES);
  private buoy = new Float32Array(MAX_PARTICLES);
  private n = 0;
  private carry = new Map<string, number>();
  private gestures_: GestureTracker[] = [];
  private breathing: boolean[] = [];
  private out = { smoke: new Float32Array(MAX_PARTICLES * 7), fire: new Float32Array(MAX_PARTICLES * 7) };

  get busy() {
    return this.n > 0;
  }

  /** Current gesture per hand (after hysteresis). */
  get gestures(): Gesture[] {
    return this.gestures_.map((g) => g.current);
  }

  /** Emits `rate` particles per second, carrying fractional particles between frames. */
  private emitCount(key: string, rate: number, dt: number) {
    const v = (this.carry.get(key) ?? 0) + rate * dt;
    const k = Math.floor(v);
    this.carry.set(key, v - k);
    return k;
  }

  private spawn(kind: P, x: number, y: number, vx: number, vy: number, life: number, s0: number, s1: number, buoy: number) {
    if (this.n >= MAX_PARTICLES) return;
    const i = this.n++;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.age[i] = 0;
    this.life[i] = life;
    this.s0[i] = s0;
    this.s1[i] = s1;
    this.kind[i] = kind;
    this.buoy[i] = buoy;
  }

  update(dt: number, nowSec: number, res: V2, faces: Float32Array[], blend: Float32Array[] | null, hands: Float32Array[], enabled: boolean, forceGesture?: Gesture): MagicFrame {
    dt = Math.min(dt, 0.1);
    const flames: Flame[] = [];
    const lights: Light[] = [];
    const [W, H] = res;

    if (enabled) {
      // ── Mouth: fire breath / smoke ──
      faces.forEach((lm, i) => {
        const b = blend?.[i];
        if (!b) return;
        const px = (j: number): V2 => [lm[j * 2] * W, lm[j * 2 + 1] * H];
        const top = px(10), chin = px(152);
        const S = Math.hypot(top[0] - chin[0], top[1] - chin[1]);
        const down: V2 = [(chin[0] - top[0]) / S, (chin[1] - top[1]) / S];
        const m: V2 = [(px(13)[0] + px(14)[0]) / 2, (px(13)[1] + px(14)[1]) / 2];
        const jaw = b[JAW];
        const wasBreathing = this.breathing[i] ?? false;
        const breathing = wasBreathing ? jaw > 0.35 : jaw > 0.5;
        this.breathing[i] = breathing;
        if (breathing) {
          const power = smooth(0.3, 0.8, jaw);
          for (let k = this.emitCount(`fire${i}`, 190 * power, dt); k > 0; k--) {
            const a = rnd() * Math.PI * 2, sp = S * (0.35 + 0.9 * rnd());
            this.spawn(P.Fire, m[0] + (rnd() - 0.5) * S * 0.06, m[1] + (rnd() - 0.5) * S * 0.04,
              Math.cos(a) * sp * 0.6 + down[0] * S * 0.5, Math.sin(a) * sp * 0.45 + down[1] * S * 0.5,
              0.45 + 0.45 * rnd(), S * 0.06, S * (0.38 + 0.3 * rnd()), S * 1.6);
          }
          for (let k = this.emitCount(`spark${i}`, 40 * power, dt); k > 0; k--) {
            const a = rnd() * Math.PI * 2, sp = S * (0.8 + 1.4 * rnd());
            this.spawn(P.Spark, m[0], m[1], Math.cos(a) * sp, Math.sin(a) * sp * 0.6 + down[1] * S * 0.3, 0.6 + 0.6 * rnd(), S * 0.025, S * 0.01, S * 0.8);
          }
          lights.push({ x: m[0] + down[0] * S * 0.2, y: m[1] + down[1] * S * 0.2, radius: S * 1.5, intensity: 0.45 * power * (0.85 + 0.15 * Math.sin(nowSec * 30)) });
        } else if (b[PUCKER] > 0.45 || b[FUNNEL] > 0.35) {
          for (let k = this.emitCount(`smoke${i}`, 45, dt); k > 0; k--) {
            this.spawn(P.Smoke, m[0], m[1], (rnd() - 0.5) * S * 0.35 + down[0] * S * 0.25, (rnd() - 0.2) * S * 0.2 + down[1] * S * 0.1,
              2.2 + 1.2 * rnd(), S * 0.05, S * (0.45 + 0.35 * rnd()), S * 0.25);
          }
        }
      });

      // ── Hands ──
      hands.forEach((h, i) => {
        const g = (this.gestures_[i] ??= new GestureTracker()).update(forceGesture ?? classifyHand(h, res));
        const px = (j: number): V2 => [h[j * 2] * W, h[j * 2 + 1] * H];
        const hs = Math.hypot(px(0)[0] - px(9)[0], px(0)[1] - px(9)[1]); // wrist → middle knuckle
        if (hs < 12) return;
        /** A flame burning on a fingertip, nudged past the tip along the finger. */
        const fingerFlame = (tipIdx: number, dipIdx: number, size: number, seed: number, sparks: number) => {
          const tip = px(tipIdx), dip = px(dipIdx);
          const len = Math.hypot(tip[0] - dip[0], tip[1] - dip[1]) || 1;
          const f: V2 = [tip[0] + ((tip[0] - dip[0]) / len) * hs * 0.06, tip[1] + ((tip[1] - dip[1]) / len) * hs * 0.06];
          flames.push({ x: f[0], y: f[1], size, kind: 0, seed });
          for (let k = this.emitCount(`tip${i}-${tipIdx}`, sparks, dt); k > 0; k--) {
            this.spawn(P.Spark, f[0], f[1], (rnd() - 0.5) * hs * 0.5, -hs * (0.4 + 0.8 * rnd()), 0.4 + 0.5 * rnd(), hs * 0.025, hs * 0.008, hs * 0.5);
          }
          return f;
        };
        if (g === 'palm') {
          // Every fingertip burns like a candle wick (thumb included).
          let lx = 0, ly = 0;
          [[4, 3], [8, 7], [12, 11], [16, 15], [20, 19]].forEach(([tip, dip], k) => {
            const f = fingerFlame(tip, dip, hs * (k === 0 ? 0.3 : 0.34), i * 7.3 + k * 1.7, 10);
            lx += f[0] / 5;
            ly += f[1] / 5;
          });
          lights.push({ x: lx, y: ly - hs * 0.2, radius: hs * 3.4, intensity: 0.8 * (0.9 + 0.1 * Math.sin(nowSec * 17 + i)) });
        } else if (g === 'point') {
          const f = fingerFlame(8, 7, hs * 0.4, i * 5.7 + 2, 25);
          lights.push({ x: f[0], y: f[1] - hs * 0.15, radius: hs * 2.6, intensity: 0.6 });
        } else if (g === 'fist') {
          // A fireball held just above the knuckles.
          let cx = 0, cy = 0;
          for (const j of [5, 9, 13, 17]) {
            cx += px(j)[0] / 4;
            cy += px(j)[1] / 4;
          }
          const orb: V2 = [cx, cy - hs * 0.75];
          const r = hs * 0.5 * (0.92 + 0.08 * Math.sin(nowSec * 9 + i));
          flames.push({ x: orb[0], y: orb[1], size: r, kind: 1, seed: i * 3.1 });
          for (let k = this.emitCount(`orb${i}`, 70, dt); k > 0; k--) {
            const a = rnd() * Math.PI * 2;
            this.spawn(P.Fire, orb[0] + Math.cos(a) * r * 0.5, orb[1] + Math.sin(a) * r * 0.5, Math.cos(a) * hs * 0.3, Math.sin(a) * hs * 0.2 - hs * 0.5, 0.5 + 0.4 * rnd(), r * 0.35, r * 0.15, hs * 1.2);
          }
          lights.push({ x: orb[0], y: orb[1], radius: hs * 4, intensity: 0.7 });
        }
      });
      this.gestures_.length = hands.length;
    }

    // ── Simulate ──
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      const a = (this.age[i] += dt);
      if (a >= this.life[i]) continue;
      const drag = this.kind[i] === P.Smoke ? 1.6 : 2.4;
      this.vx[i] *= Math.exp(-drag * dt);
      this.vy[i] = this.vy[i] * Math.exp(-drag * dt) - this.buoy[i] * dt;
      // Curl-ish turbulence so smoke and flames billow instead of moving in straight lines.
      const sw = Math.sin(this.y[i] * 0.03 + nowSec * 3 + i) * this.s1[i] * 0.6;
      this.x[i] += (this.vx[i] + sw) * dt;
      this.y[i] += this.vy[i] * dt;
      if (w !== i) {
        this.x[w] = this.x[i]; this.y[w] = this.y[i]; this.vx[w] = this.vx[i]; this.vy[w] = this.vy[i];
        this.age[w] = a; this.life[w] = this.life[i]; this.s0[w] = this.s0[i]; this.s1[w] = this.s1[i];
        this.kind[w] = this.kind[i]; this.buoy[w] = this.buoy[i];
      }
      w++;
    }
    this.n = w;

    // ── Draw lists ──
    let sc = 0, fc = 0;
    const { smoke, fire } = this.out;
    for (let i = 0; i < this.n; i++) {
      const t = this.age[i] / this.life[i];
      const size = this.s0[i] + (this.s1[i] - this.s0[i]) * Math.sqrt(t);
      if (this.kind[i] === P.Smoke) {
        const alpha = 0.32 * smooth(0, 0.1, t) * (1 - smooth(0.4, 1, t));
        const g = 0.62 + 0.15 * (1 - t);
        smoke.set([this.x[i] / W, this.y[i] / H, size, g * alpha, g * alpha, g * 1.03 * alpha, alpha], sc++ * 7);
      } else {
        // Blackbody-ish ramp: white-yellow core → orange → deep red → gone.
        const heat = 1 - t;
        const spark = this.kind[i] === P.Spark;
        const r = 1.0, gch = 0.25 + 0.7 * heat * heat, b = 0.05 + 0.5 * Math.pow(heat, 4);
        const alpha = (spark ? 1 : 0.3) * smooth(0, 0.08, t) * (1 - smooth(0.55, 1, t));
        fire.set([this.x[i] / W, this.y[i] / H, size, r * alpha, gch * alpha, b * alpha, alpha], fc++ * 7);
      }
    }
    return { smoke, smokeCount: sc, fire, fireCount: fc, flames, lights: lights.slice(0, 4) };
  }
}

/** Curved talons from each fingertip, as strips (x, y uv, t along, s across). */
export function buildClaws(hands: Float32Array[], res: V2): Float32Array[] {
  const [W, H] = res;
  const out: Float32Array[] = [];
  const SEG = 8;
  for (const h of hands) {
    const px = (j: number): V2 => [h[j * 2] * W, h[j * 2 + 1] * H];
    let cx = 0, cy = 0;
    for (const j of [0, 5, 9, 13, 17]) {
      cx += px(j)[0] / 5;
      cy += px(j)[1] / 5;
    }
    for (const chain of [...FINGERS.map((f) => [f[2], f[3]]), [THUMB[1], THUMB[2]]]) {
      const dip = px(chain[0]), tip = px(chain[1]);
      const seg = Math.hypot(tip[0] - dip[0], tip[1] - dip[1]);
      if (seg < 2) continue;
      const d: V2 = [(tip[0] - dip[0]) / seg, (tip[1] - dip[1]) / seg];
      let n: V2 = [-d[1], d[0]];
      // Curl toward the palm.
      if ((cx - tip[0]) * n[0] + (cy - tip[1]) * n[1] < 0) n = [-n[0], -n[1]];
      const len = seg * 1.5, base: V2 = [tip[0] - d[0] * seg * 0.35, tip[1] - d[1] * seg * 0.35];
      const data = new Float32Array((SEG + 1) * 2 * 4);
      let k = 0;
      for (let i = 0; i <= SEG; i++) {
        const t = i / SEG;
        const c: V2 = [base[0] + d[0] * len * t + n[0] * len * 0.35 * t * t, base[1] + d[1] * len * t + n[1] * len * 0.35 * t * t];
        const tan: V2 = [d[0] + n[0] * 0.7 * t, d[1] + n[1] * 0.7 * t];
        const tl = Math.hypot(tan[0], tan[1]);
        const w = seg * 0.32 * Math.pow(1 - t, 0.8) + 0.4;
        for (const s of [-1, 1]) {
          data[k++] = (c[0] - (tan[1] / tl) * w * s) / W;
          data[k++] = (c[1] + (tan[0] / tl) * w * s) / H;
          data[k++] = t;
          data[k++] = s;
        }
      }
      out.push(data);
    }
  }
  return out;
}
