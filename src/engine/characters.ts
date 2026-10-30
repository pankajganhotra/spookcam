// Head-anchored geometry for the character looks: hair/fur halo, horns, hat, ears, nose, bolts,
// hair curtains. Everything is built per frame in pixel space from the face's own frame
// (up = chin → forehead, right = perpendicular), so props follow head tilt and scale.
import { FACE_OVAL } from './facemesh-data';
import { FILTERS } from './face-shaders';

type V2 = [number, number];

export interface FaceFrame {
  res: V2;
  px(i: number): V2;
  up: V2;
  right: V2;
  /** Forehead-top to chin, pixels. */
  faceH: number;
  /** Ear to ear, pixels. */
  faceW: number;
  center: V2;
}

export function faceFrame(lm: Float32Array, res: V2): FaceFrame | null {
  const px = (i: number): V2 => [lm[i * 2] * res[0], lm[i * 2 + 1] * res[1]];
  const top = px(10), chin = px(152);
  const faceH = Math.hypot(top[0] - chin[0], top[1] - chin[1]);
  if (faceH < 20) return null;
  const up: V2 = [(top[0] - chin[0]) / faceH, (top[1] - chin[1]) / faceH];
  const right: V2 = [-up[1], up[0]];
  const l = px(234), r = px(454);
  let cx = 0, cy = 0;
  for (const i of FACE_OVAL) {
    const p = px(i);
    cx += p[0] / FACE_OVAL.length;
    cy += p[1] / FACE_OVAL.length;
  }
  return { res, px, up, right, faceH, faceW: Math.hypot(r[0] - l[0], r[1] - l[1]), center: [cx, cy] };
}

const mul = (v: V2, k: number): V2 => [v[0] * k, v[1] * k];
const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];

const add = (a: V2, ...terms: [V2, number][]): V2 => {
  let x = a[0], y = a[1];
  for (const [v, k] of terms) {
    x += v[0] * k;
    y += v[1] * k;
  }
  return [x, y];
};

// ── Halo ──

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** How far the halo reaches past each face-oval point, as a fraction of its distance from center. */
const HALO: Partial<Record<number, (up: number, side: number) => number>> = {
  [FILTERS.clown]: (u, s) => 0.06 + 0.6 * smooth(0.5, 0.9, s) * smooth(-0.7, 0.1, u),
  [FILTERS.monster]: (u) => 0.24 * smooth(0.3, 0.6, u),
  [FILTERS.werewolf]: (u) => 0.45 - 0.15 * smooth(-0.2, -0.9, u),
  [FILTERS.mummy]: () => 0.2,
  [FILTERS.witch]: (u, s) => 0.1 + 0.55 * smooth(0.3, 0.8, s) * smooth(0.9, -0.4, u),
  [FILTERS.onryo]: (u, s) => 0.22 + 1.1 * smooth(0.4, 0.85, s) * smooth(0.5, -0.7, u),
};

export const hasHalo = (filter: number) => filter in HALO;

/**
 * Triangle strip (inner, outer, inner, outer, …, closing pair) with interleaved
 * x, y, rad, side, up per vertex. Returns the vertex count.
 */
export function buildHalo(filter: number, f: FaceFrame, out: Float32Array): number {
  const profile = HALO[filter];
  if (!profile) return 0;
  const [W, H] = f.res;
  let k = 0;
  for (let j = 0; j <= FACE_OVAL.length; j++) {
    const p = f.px(FACE_OVAL[j % FACE_OVAL.length]);
    const dx = p[0] - f.center[0], dy = p[1] - f.center[1];
    const n = Math.hypot(dx, dy) || 1;
    const up = (dx * f.up[0] + dy * f.up[1]) / n;
    const side = (dx * f.right[0] + dy * f.right[1]) / n;
    const reach = profile(up, Math.abs(side));
    // Start slightly inside the face edge so the paint's soft skirt overlaps the hairline.
    const overlap = f.faceH * 0.03 * Math.min(1, reach / 0.1); // collapses where there is no hair
    const inner: V2 = [p[0] - (dx / n) * overlap, p[1] - (dy / n) * overlap];
    const outer: V2 = [p[0] + dx * reach, p[1] + dy * reach];
    for (const [q, rad] of [[inner, 0], [outer, 1]] as const) {
      out[k++] = q[0] / W;
      out[k++] = q[1] / H;
      out[k++] = rad;
      out[k++] = side;
      out[k++] = up;
    }
  }
  return k / 5;
}

// ── Props ──

export const PROP = { horn: 0, cone: 1, disk: 2, sphere: 3, ear: 4, curtain: 5, claw: 7 } as const;

export interface Prop {
  kind: number;
  color: [number, number, number];
  mode: 'strip' | 'fan';
  data: Float32Array;
  count: number;
  /** Drawn before the face paint (behind it) or after (in front). */
  layer: 'back' | 'front';
}

/** Strip along a centerline; local = (t along, s across −1..1). Negative width flips s. */
function strip(f: FaceFrame, c: (t: number) => V2, halfW: (t: number) => number, segs = 20): Float32Array {
  const [W, H] = f.res;
  const d = new Float32Array((segs + 1) * 2 * 4);
  let k = 0;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const p = c(t);
    const p2 = c(Math.min(1, t + 0.01)), p0 = c(Math.max(0, t - 0.01));
    let tx = p2[0] - p0[0], ty = p2[1] - p0[1];
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    const w = halfW(t);
    for (const s of [-1, 1]) {
      d[k++] = (p[0] - ty * w * s) / W;
      d[k++] = (p[1] + tx * w * s) / H;
      d[k++] = t;
      d[k++] = s;
    }
  }
  return d;
}

/** Ellipse fan; local = unit-disk coordinates. */
function disk(f: FaceFrame, center: V2, ax: V2, ay: V2, segs = 28): Float32Array {
  const [W, H] = f.res;
  const d = new Float32Array((segs + 2) * 4);
  d.set([center[0] / W, center[1] / H, 0, 0]);
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    const p = add(center, [ax, c], [ay, s]);
    d.set([p[0] / W, p[1] / H, c, s], (i + 1) * 4);
  }
  return d;
}

const prop = (kind: number, color: Prop['color'], mode: Prop['mode'], data: Float32Array, layer: Prop['layer']): Prop => ({
  kind,
  color,
  mode,
  data,
  count: data.length / 4,
  layer,
});

/** Which side of the face (−1 / +1 along `right`) a landmark sits on. */
const sideOf = (f: FaceFrame, p: V2) => Math.sign((p[0] - f.center[0]) * f.right[0] + (p[1] - f.center[1]) * f.right[1]) || 1;

export function propsFor(filter: number, f: FaceFrame): Prop[] {
  const { up, right, faceH: H, faceW: W } = f;
  const props: Prop[] = [];

  if (filter === FILTERS.demon) {
    for (const anchor of [67, 297]) {
      const a = f.px(anchor);
      const out = sideOf(f, a);
      const b = add(a, [up, H * 0.02]);
      const curve = (t: number): V2 => add(b, [right, (0.16 * t + 0.1 * Math.sin(t * Math.PI * 0.9) - 0.12 * t ** 3) * H * out], [up, (0.42 * t - 0.06 * t * t) * H]);
      props.push(prop(PROP.horn, [0, 0, 0], 'strip', strip(f, curve, (t) => 0.065 * H * (1 - t) ** 0.85 + 0.5), 'front'));
    }
  }

  if (filter === FILTERS.werewolf) {
    for (const anchor of [103, 332]) {
      const a = f.px(anchor);
      const out = sideOf(f, a);
      const base = add(a, [sub(a, f.center), 0.3], [up, H * 0.06]);
      const curve = (t: number): V2 => add(base, [up, 0.36 * H * t], [right, 0.12 * H * t * out]);
      props.push(prop(PROP.ear, [0, 0, 0], 'strip', strip(f, curve, (t) => 0.13 * H * (1 - t) + 0.5, 12), 'back'));
    }
  }

  if (filter === FILTERS.clown) {
    const tip = f.px(1);
    const r = 0.11 * W;
    props.push(prop(PROP.sphere, [0.85, 0.03, 0.04], 'fan', disk(f, add(tip, [up, r * 0.15]), mul(right, r), mul(up, -r)), 'front'));
  }

  if (filter === FILTERS.monster) {
    for (const anchor of [172, 397]) {
      const a = f.px(anchor);
      const c = add(a, [sub(a, f.center), 0.16], [up, -0.1 * H]);
      const r = 0.07 * W;
      props.push(prop(PROP.sphere, [0.42, 0.44, 0.47], 'fan', disk(f, c, mul(right, r), mul(up, -r * 0.85)), 'front'));
    }
  }

  if (filter === FILTERS.witch) {
    const b = add(f.px(10), [up, 0.1 * H]);
    props.push(prop(PROP.disk, [0.05, 0.045, 0.06], 'fan', disk(f, b, mul(right, 0.95 * W), mul(up, 0.17 * H)), 'front'));
    const lean = -1;
    const curve = (t: number): V2 => add(b, [up, 1.05 * H * t], [right, 0.32 * H * t ** 2.5 * lean]);
    props.push(prop(PROP.cone, [0.05, 0.045, 0.06], 'strip', strip(f, curve, (t) => 0.44 * W * (1 - t) ** 1.1 + 1.5, 24), 'front'));
  }

  if (filter === FILTERS.onryo) {
    for (const side of [-1, 1]) {
      const top = add(f.px(10), [up, 0.2 * H], [right, side * 0.36 * W]);
      const curve = (t: number): V2 => add(top, [up, -1.75 * H * t], [right, side * (0.06 * W + 0.12 * W * t)]);
      // Make s = +1 the inner (face-side) edge on both curtains.
      const probe = curve(0.5), probe2 = curve(0.51);
      const tx = probe2[0] - probe[0], ty = probe2[1] - probe[1];
      const sPlusIsOuter = (-ty * right[0] + tx * right[1]) * side > 0;
      const w = 0.14 * W;
      props.push(prop(PROP.curtain, [0, 0, 0], 'strip', strip(f, curve, (t) => (sPlusIsOuter ? -1 : 1) * (w + 0.06 * W * t), 16), 'front'));
    }
  }

  return props;
}
