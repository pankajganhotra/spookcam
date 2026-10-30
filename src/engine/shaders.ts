// GLSL ES 3.0 shaders. Texture convention everywhere: uv (0,0) = top-left of the image,
// v grows downward (matches VideoFrame uploads and MediaPipe normalized landmarks).
// Only the final POST pass flips Y for the canvas.

export const HEADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
`;

export const COMMON = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}
/** Thin bright lines where fbm crosses 0.5 — veins, cracks, lava seams. */
float ridge(vec2 p, float sharp) {
  return pow(1.0 - abs(fbm(p) * 2.0 - 1.0), sharp);
}
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
/** Normalized distance to an axis-aligned ellipse: <1 inside. */
float ell(vec2 p, vec2 c, vec2 r) { return length((p - c) / r); }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
/** iq: equilateral triangle pointing toward +y, signed distance. */
float sdTri(vec2 p, float r) {
  const float k = 1.7320508;
  p.x = abs(p.x) - r;
  p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}
`;

/** Shared between the composite pass and particle VS so dust leaves exactly where skin vanishes. */
export const VANISH = /* glsl */ `
uniform vec2 uWind;     // unit vector in uv space
uniform float uAspect;  // width / height
/** 0..1: when (as a fraction of the sweep duration) this pixel turns to dust. */
float emitFrac(vec2 uv) {
  float sweep = 1.0 - (dot(uv - 0.5, uWind) + 0.5);
  float n = fbm(uv * vec2(uAspect, 1.0) * 4.5 + 3.7);
  float fine = noise(uv * vec2(uAspect, 1.0) * 40.0);
  return clamp(0.62 * sweep + 0.75 * (n - 0.5) + 0.12 * (fine - 0.5) + 0.14, 0.0, 1.0);
}
`;

export const QUAD_VS = /* glsl */ `${HEADER}
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const COPY_FS = /* glsl */ `${HEADER}
in vec2 vUv;
uniform sampler2D uTex;
out vec4 o;
void main() { o = texture(uTex, vUv); }
`;

/** Temporal + spatial smoothing of the raw segmentation confidence. */
export const MASK_FS = /* glsl */ `${HEADER}
in vec2 vUv;
uniform sampler2D uRaw, uPrev;
uniform vec2 uTexel;
uniform float uBlend;
out vec4 o;
void main() {
  float c = texture(uRaw, vUv).r * 0.4;
  c += texture(uRaw, vUv + vec2(uTexel.x, 0)).r * 0.15;
  c += texture(uRaw, vUv - vec2(uTexel.x, 0)).r * 0.15;
  c += texture(uRaw, vUv + vec2(0, uTexel.y)).r * 0.15;
  c += texture(uRaw, vUv - vec2(0, uTexel.y)).r * 0.15;
  float prev = texture(uPrev, vUv).r;
  o = vec4(mix(prev, c, uBlend), 0, 0, 1);
}
`;

/**
 * Background plate learning. Stores premultiplied (rgb*a, a); `a` = how sure we are this
 * pixel's background has been seen. Mipmaps of this texture give a pull-push hole fill.
 */
export const PLATE_FS = /* glsl */ `${HEADER}
in vec2 vUv;
uniform sampler2D uPlate, uCam, uMask;
uniform vec2 uMaskTexel;
out vec4 o;
void main() {
  vec4 old = textureLod(uPlate, vUv, 0.0);
  // Dilate the person mask so edge pixels (hair, shoulders) never pollute the plate.
  float m = texture(uMask, vUv).r;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398;
    m = max(m, texture(uMask, vUv + vec2(cos(a), sin(a)) * uMaskTexel * 3.0).r);
  }
  float bg = 1.0 - smoothstep(0.06, 0.3, m);
  float rate = bg * mix(0.55, 0.07, old.a);
  o = mix(old, vec4(texture(uCam, vUv).rgb, 1.0), rate);
}
`;

/** Per-texel (person × known-background, person) for measuring how much of the area behind you is learned. */
export const COVERAGE_FS = /* glsl */ `${HEADER}
in vec2 vUv;
uniform sampler2D uMask, uPlate;
out vec4 o;
void main() {
  float m = smoothstep(0.3, 0.7, texture(uMask, vUv).r);
  float a = textureLod(uPlate, vUv, 2.0).a;
  o = vec4(m * smoothstep(0.3, 0.8, a), m, 0.0, 1.0);
}
`;

// ───────────────────────────────── Composite ─────────────────────────────────

export const COMPOSITE_FS = /* glsl */ `${HEADER}
${COMMON}
${VANISH}
in vec2 vUv;
uniform sampler2D uPerson, uMask, uPlate;
uniform bool uHasMask, uNeedFill, uGhost;
uniform int uBackdrop, uStyle;
uniform float uT, uDur, uTime, uPlateLods;
uniform vec2 uMaskTexel;
out vec4 o;

/** Pull-push hole fill: walk the plate mip chain until enough coverage is gathered. */
vec3 plateFill(vec2 uv) {
  vec3 acc = vec3(0.0);
  float remain = 1.0;
  for (int i = 0; i < 13; i++) {
    float lod = float(i);
    if (lod > uPlateLods) break;
    vec4 s = textureLod(uPlate, uv, lod);
    float conf = clamp(s.a * 1.6 - 0.1, 0.0, 1.0);
    acc += remain * conf * s.rgb / max(s.a, 1e-4);
    remain *= 1.0 - conf;
    if (remain < 0.01) break;
  }
  return acc + remain * vec3(0.08, 0.08, 0.09);
}

float personMask(vec2 uv) {
  if (!uHasMask) return 0.0;
  return smoothstep(0.32, 0.72, texture(uMask, uv).r);
}

// ── Backdrops (p: aspect-corrected, y up) ──
vec3 sky(vec2 p, vec3 top, vec3 bottom) { return mix(bottom, top, smoothstep(0.0, 1.0, p.y)); }

float stars(vec2 p) {
  vec2 cell = floor(p * 90.0);
  float h = hash12(cell);
  vec2 c = (cell + hash22(cell)) / 90.0;
  return step(0.985, h) * smoothstep(0.004, 0.0, length(p - c)) * (0.6 + 0.4 * sin(uTime * 2.0 + h * 50.0));
}

vec3 moon(vec2 p, vec2 c, float r, vec3 tint, inout vec3 col) {
  float d = length(p - c);
  float craters = fbm((p - c) * 14.0);
  vec3 disc = tint * (0.82 + 0.25 * craters);
  col += tint * 0.35 * exp(-max(d - r, 0.0) * 9.0);
  return mix(col, disc, smoothstep(r + 0.003, r - 0.003, d));
}

float bat(vec2 p, vec2 c, float s, float flap) {
  vec2 q = (p - c) / s;
  q.x = abs(q.x);
  float body = length(q / vec2(0.18, 0.32));
  float wing = q.y - (0.25 * flap - 0.55 * q.x + 0.35 * sin(q.x * 9.0) * 0.25);
  float wingMask = step(q.x, 1.0) * step(-0.45 + 0.3 * flap, q.y) * step(wing, 0.0) * step(q.y, 0.15 + 0.3 * flap);
  return max(step(body, 1.0), wingMask);
}

vec3 graveyard(vec2 uv) {
  vec2 p = vec2(uv.x * uAspect, 1.0 - uv.y);
  vec3 col = sky(p, vec3(0.01, 0.02, 0.06), vec3(0.13, 0.17, 0.3));
  col += stars(p) * 0.8;
  col = moon(p, vec2(0.78 * uAspect, 0.78), 0.1, vec3(0.95, 0.93, 0.8), col);
  float clouds = fbm(vec2(p.x * 2.0 - uTime * 0.03, p.y * 4.0));
  col = mix(col, vec3(0.05, 0.06, 0.1), smoothstep(0.5, 0.8, clouds) * smoothstep(0.35, 0.8, p.y) * 0.8);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float t = uTime * (0.07 + 0.03 * fi) + fi * 2.1;
    vec2 c = vec2(fract(t) * (uAspect + 0.4) - 0.2, 0.62 + 0.18 * sin(t * 6.0 + fi) + 0.08 * fi);
    col = mix(col, vec3(0.0), bat(p, c, 0.03 + 0.008 * fi, sin(uTime * 14.0 + fi * 2.0)));
  }
  float hill = 0.2 + 0.04 * sin(p.x * 3.1) + 0.025 * sin(p.x * 7.3 + 1.0);
  // Tombstones on the hill line.
  float cw = 0.24;
  float cell = floor(p.x / cw);
  float h = hash12(vec2(cell, 3.0));
  float cx = (cell + 0.5) * cw + (h - 0.5) * 0.08;
  float w = 0.035 + 0.02 * h, ht = 0.06 + 0.06 * hash12(vec2(cell, 9.0));
  vec2 sp = p - vec2(cx, hill - 0.01);
  float stone = h > 0.5
    ? min(max(abs(sp.x) - w, abs(sp.y - ht * 0.5) - ht * 0.5), length(sp - vec2(0.0, ht)) - w)
    : min(max(abs(sp.x) - w * 0.3, abs(sp.y - ht * 0.75) - ht * 0.75), max(abs(sp.x) - w, abs(sp.y - ht * 1.05) - w * 0.3));
  float ground = step(p.y, hill);
  col = mix(col, vec3(0.015, 0.02, 0.03), max(ground, step(stone, 0.0) * step(0.0, sp.y + 0.02)));
  float fog = fbm(vec2(p.x * 2.5 + uTime * 0.05, p.y * 6.0 - uTime * 0.02));
  col = mix(col, vec3(0.45, 0.5, 0.6), fog * smoothstep(0.38, 0.05, p.y) * 0.65);
  return col;
}

vec3 bloodmoon(vec2 uv) {
  vec2 p = vec2(uv.x * uAspect, 1.0 - uv.y);
  vec3 col = sky(p, vec3(0.04, 0.0, 0.01), vec3(0.32, 0.02, 0.03));
  col = moon(p, vec2(0.8 * uAspect, 0.68), 0.17, vec3(0.75, 0.08, 0.05), col);
  float clouds = fbm(vec2(p.x * 1.6 - uTime * 0.04, p.y * 3.5));
  col = mix(col, vec3(0.06, 0.0, 0.01), smoothstep(0.45, 0.75, clouds) * 0.85);
  // Pine-forest silhouette.
  float cw = 0.055;
  float cell = floor(p.x / cw);
  float h = hash12(vec2(cell, 1.0));
  float local = abs(fract(p.x / cw) - 0.5) * 2.0;
  float tree = 0.16 + h * 0.16 - local * (0.12 + h * 0.1);
  float line = max(tree, 0.14 + 0.02 * sin(p.x * 5.0));
  col = mix(col, vec3(0.02, 0.0, 0.0), step(p.y, line));
  float fog = fbm(vec2(p.x * 3.0 + uTime * 0.06, p.y * 5.0));
  col = mix(col, vec3(0.5, 0.05, 0.05), fog * smoothstep(0.3, 0.0, p.y) * 0.7);
  return col;
}

vec3 voidScene(vec2 uv) {
  vec2 p = vec2(uv.x * uAspect, 1.0 - uv.y);
  float smoke = fbm(p * 2.5 + vec2(uTime * 0.03, -uTime * 0.05) + fbm(p * 3.0 - uTime * 0.02));
  vec3 col = vec3(0.012, 0.01, 0.014) + vec3(0.09, 0.06, 0.07) * smoothstep(0.35, 0.9, smoke);
  // Pairs of eyes that blink open in the dark.
  vec2 grid = vec2(6.0, 4.0);
  vec2 cell = floor(uv * grid);
  vec2 h = hash22(cell + 5.0);
  float phase = hash12(cell + 2.0) * 6.28;
  float open = smoothstep(0.75, 0.9, sin(uTime * (0.3 + 0.4 * h.x) + phase));
  vec2 c = (cell + 0.3 + 0.4 * h) / grid;
  vec2 d = (uv - c) * vec2(uAspect, 1.0);
  float sep = 0.022 + 0.01 * h.y;
  vec2 e1 = d - vec2(sep, 0.0), e2 = d + vec2(sep, 0.0);
  float eyeShape = min(length(e1 / vec2(0.011, 0.005 * open + 1e-4)), length(e2 / vec2(0.011, 0.005 * open + 1e-4)));
  vec3 eyeCol = h.x > 0.5 ? vec3(1.0, 0.1, 0.05) : vec3(1.0, 0.75, 0.1);
  col += eyeCol * smoothstep(1.0, 0.6, eyeShape) * open * step(0.35, h.y);
  col += eyeCol * 0.15 * exp(-min(length(e1), length(e2)) * 60.0) * open * step(0.35, h.y);
  return col;
}

vec3 ghostly(vec2 uv, float m) {
  vec2 wuv = uv + vec2(sin(uv.y * 40.0 + uTime * 3.0) * 0.003, 0.0);
  vec3 c = texture(uPerson, wuv).rgb;
  float l = luma(c);
  vec3 g = mix(vec3(l), c, 0.2) * vec3(0.75, 0.88, 1.05) * 1.25;
  return g;
}

void main() {
  vec2 uv = vUv;
  vec4 person = texture(uPerson, uv);
  float m = personMask(uv);

  vec3 bg;
  if (uBackdrop == 1) bg = graveyard(uv);
  else if (uBackdrop == 2) bg = bloodmoon(uv);
  else if (uBackdrop == 3) bg = voidScene(uv);
  else bg = uNeedFill ? plateFill(uv) : person.rgb;

  // Disintegration front.
  float e = emitFrac(uv) * uDur;
  float vis = uT <= 0.0 ? 1.0 : smoothstep(e + 0.02, e - 0.12, uT);
  vec3 fg = person.rgb;
  float alpha = m * vis;
  if (uGhost) {
    float flick = 0.5 + 0.15 * sin(uTime * 7.0) * sin(uTime * 3.1) + 0.1 * noise(vec2(uTime * 5.0, uv.y * 4.0));
    fg = ghostly(uv, m);
    alpha *= flick;
  }
  vec3 col = mix(bg, fg, alpha);

  if (uT > 0.0 && uHasMask) {
    float front = m * smoothstep(0.16, 0.0, abs(uT - e + 0.04)) * step(uT, uDur + 0.2);
    if (uStyle == 0) { // dust: the front chars to ash
      col = mix(col, vec3(0.2, 0.17, 0.14), front * 0.55);
    } else if (uStyle == 1) { // embers: glowing burn line
      float n = noise(uv * 120.0 + uTime);
      col = mix(col, vec3(0.08, 0.03, 0.02), front * 0.6) + vec3(1.0, 0.4, 0.06) * pow(front, 2.0) * (0.7 + 0.6 * n);
    } else { // cloak: refractive shimmer at the front and a faint ripple while invisible
      float mx = texture(uMask, uv + vec2(uMaskTexel.x * 2.0, 0)).r - texture(uMask, uv - vec2(uMaskTexel.x * 2.0, 0)).r;
      float my = texture(uMask, uv + vec2(0, uMaskTexel.y * 2.0)).r - texture(uMask, uv - vec2(0, uMaskTexel.y * 2.0)).r;
      vec2 grad = vec2(mx, my);
      float ripple = 0.5 + 0.5 * sin(uTime * 4.0 + uv.y * 60.0);
      vec2 off = grad * (0.012 + 0.01 * ripple) + vec2(0.004, 0.0) * front;
      vec3 refr = (uBackdrop == 0 ? plateFill(uv + off) : bg);
      float shimmer = clamp(length(grad) * 4.0, 0.0, 1.0) * (1.0 - vis) * m;
      col = mix(col, refr, max(shimmer * 0.85, front));
      col += vec3(0.55, 0.75, 1.0) * pow(front, 3.0) * 0.18;
    }
  }
  o = vec4(col, 1.0);
}
`;

// ───────────────────────────────── Particles ─────────────────────────────────

export const PARTICLE_VS = /* glsl */ `${HEADER}
${COMMON}
${VANISH}
uniform sampler2D uSrc, uSrcMask;
uniform vec2 uGrid;
uniform float uT, uDur, uLife, uPointPx;
uniform int uStyle;
out vec4 vColor;
void main() {
  int gw = int(uGrid.x);
  vec2 g = vec2(float(gl_VertexID % gw), float(gl_VertexID / gw));
  vec2 j = hash22(g + 0.5);
  vec2 home = (g + j) / uGrid;
  float m = texture(uSrcMask, home).r;
  float age = uT - emitFrac(home) * uDur;
  vec2 r = hash22(g.yx * 1.7 + 11.0);
  bool keep = m > 0.5 && age > 0.0 && age < uLife * (0.6 + 0.4 * r.y);
  if (uStyle == 1) keep = keep && r.x < 0.16;
  if (!keep) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float a = age / uLife;
  float speed = mix(0.55, 1.5, r.x);
  vec2 drift = uWind * (0.06 * age + 0.11 * age * age) * speed;
  vec2 lift = vec2(0.0, -(0.015 + 0.03 * r.y) * age * age);
  if (uStyle == 1) { drift *= 0.35; lift *= 4.0; }
  vec2 swirl = (0.018 + 0.02 * r.y) * age * vec2(sin(home.y * 23.0 + age * 2.7 + r.y * 6.28), cos(home.x * 19.0 + age * 2.3 + r.x * 6.28));
  vec2 pos = home + drift + lift + swirl;
  vec3 col = texture(uSrc, home).rgb;
  float alpha;
  float size;
  if (uStyle == 1) {
    float heat = 1.0 - a;
    col = mix(vec3(0.6, 0.1, 0.01), vec3(1.0, 0.7, 0.3), heat * heat) * (0.45 + 0.5 * heat);
    alpha = (1.0 - smoothstep(0.5, 1.0, a)) * (0.7 + 0.3 * sin(age * 20.0 + r.x * 30.0));
    size = uPointPx * (1.6 - a) * (0.8 + 0.8 * r.y);
  } else {
    vec3 ash = vec3(0.3, 0.25, 0.2) * (0.6 + 0.6 * r.y);
    col = mix(col, ash, smoothstep(0.0, 0.45, a));
    alpha = 1.0 - smoothstep(0.35, 1.0, a);
    size = uPointPx * (1.25 - 0.55 * a) * (0.7 + 0.6 * r.y);
  }
  gl_PointSize = max(size, 1.0);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
  vColor = vec4(col * alpha, alpha);
}
`;

export const PARTICLE_FS = /* glsl */ `${HEADER}
in vec4 vColor;
out vec4 o;
void main() {
  float d = length(gl_PointCoord - 0.5);
  o = vColor * smoothstep(0.5, 0.25, d);
}
`;

// ───────────────────────────────── Post / atmosphere ─────────────────────────────────

export const POST_FS = /* glsl */ `${HEADER}
${COMMON}
in vec2 vUv;
uniform sampler2D uTex;
uniform int uTint;
uniform float uTime, uVignette, uGrain, uFlicker, uGlitch, uFog, uAspect;
uniform vec2 uRes;
out vec4 o;
void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y); // canvas is y-up
  // VHS glitch: rare torn bands + chroma split.
  float split = 0.0;
  if (uGlitch > 0.0) {
    float tick = floor(uTime * 9.0);
    float burst = step(hash12(vec2(tick, 1.0)), 0.08 + 0.3 * uGlitch);
    float band = step(hash12(vec2(floor(uv.y * 24.0), tick)), 0.25) * burst;
    uv.x += (hash12(vec2(floor(uv.y * 60.0), tick)) - 0.5) * 0.06 * uGlitch * band;
    split = (0.002 + 0.008 * burst) * uGlitch;
  }
  vec3 c = vec3(texture(uTex, uv + vec2(split, 0)).r, texture(uTex, uv).g, texture(uTex, uv - vec2(split, 0)).b);
  float l = luma(c);
  if (uTint == 1) c = mix(c, vec3(l * 1.25, l * 0.22, l * 0.2), 0.7);
  else if (uTint == 2) c = mix(c, vec3(l * 0.75, l * 1.05, l * 0.55), 0.65);
  else if (uTint == 3) c = vec3(smoothstep(0.05, 0.95, l));
  else if (uTint == 4) {
    c = vec3(0.15, 1.0, 0.25) * (smoothstep(0.0, 0.6, l) * 1.25) + (hash12(uv * uRes + uTime) - 0.5) * 0.15;
    c *= 0.85 + 0.15 * sin(uv.y * uRes.y * 1.5);
  }
  else if (uTint == 5) { // old film: sepia, crushed blacks, scratches and dust
    c = vec3(l * 1.08, l * 0.9, l * 0.66) * smoothstep(0.03, 1.0, l + 0.05);
    float scratch = step(0.997, hash12(vec2(floor(uv.x * 320.0), floor(uTime * 24.0)))) * step(0.3, hash12(vec2(floor(uTime * 24.0), 4.0)));
    c = mix(c, vec3(0.95, 0.88, 0.7), scratch * 0.5);
    c *= 0.94 + 0.06 * noise(vec2(uTime * 18.0, 1.0));
  }
  if (uFog > 0.0) {
    vec2 fp = vec2(uv.x * uAspect, uv.y);
    float f = fbm(vec2(fp.x * 2.2 + uTime * 0.06, fp.y * 3.0 - uTime * 0.03) + fbm(fp * 1.5 + uTime * 0.02));
    float low = smoothstep(0.35, 1.0, uv.y);
    c = mix(c, vec3(0.62, 0.66, 0.72) * (0.6 + 0.4 * l), smoothstep(0.35, 0.85, f) * low * uFog * 0.85);
  }
  if (uFlicker > 0.0) {
    float n = noise(vec2(uTime * 8.0, 0.0));
    float dip = step(0.82 - 0.2 * uFlicker, noise(vec2(uTime * 3.0, 7.0)));
    c *= mix(1.0, 0.55 + 0.45 * smoothstep(0.15, 0.6, n), uFlicker * dip);
    c *= 1.0 - 0.06 * uFlicker * noise(vec2(uTime * 40.0, 3.0));
  }
  if (uVignette > 0.0) {
    float d = length((uv - 0.5) * vec2(uAspect * 0.85, 1.0));
    c *= mix(1.0, smoothstep(1.05, 0.25, d), uVignette);
  }
  if (uGrain > 0.0) c += (hash12(uv * uRes + fract(uTime * 13.7) * 100.0) - 0.5) * 0.28 * uGrain;
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;
