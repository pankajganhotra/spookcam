// GLSL ES 3.0 shaders. Texture convention everywhere: uv (0,0) = top-left of the image,
// v grows downward (matches VideoFrame uploads and MediaPipe normalized landmarks).
// Only the final POST pass flips Y for the canvas.

const HEADER = /* glsl */ `#version 300 es
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

// ───────────────────────────────── Face paint ─────────────────────────────────

export const FACE_VS = /* glsl */ `${HEADER}
in vec2 aPos;
in vec2 aUv;
in float aFeather;
out vec2 vFace;
out vec2 vScreen;
out float vFeather;
void main() {
  vFace = aUv;
  vFeather = aFeather;
  vScreen = aPos;
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const FACE_FS = /* glsl */ `${HEADER}
${COMMON}
in vec2 vFace;
in vec2 vScreen;
in float vFeather;
uniform sampler2D uCam;
uniform int uFilter;
uniform float uTime, uIntensity, uSeed;
out vec4 o;

// Face UV anchors (canonical MediaPipe layout): eyes (±0.155, 0.378), nose base (0, 0.60),
// lips (0, 0.653..0.737), mouth corners ±0.118, chin 0.954. q.x is mirrored distance from center.

vec4 skull(vec2 f, vec2 q, vec3 cam, float l) {
  float shade = smoothstep(0.03, 0.85, l);
  vec3 col = vec3(0.93, 0.9, 0.82) * (0.38 + 0.78 * shade);
  col *= 0.85 + 0.15 * fbm(f * 22.0);
  // Temples and cheek hollows.
  col *= 1.0 - 0.45 * exp(-pow(ell(q, vec2(0.215, 0.6), vec2(0.075, 0.075)), 2.0));
  col *= 1.0 - 0.35 * exp(-pow(ell(q, vec2(0.43, 0.3), vec2(0.09, 0.14)), 2.0));
  // Eye sockets.
  float se = ell(q, vec2(0.15, 0.385), vec2(0.105, 0.088)) + 0.08 * (fbm(f * 9.0) - 0.5);
  col *= mix(1.0, 0.45, smoothstep(1.45, 0.95, se));
  col = mix(col, vec3(0.015, 0.0, 0.0), smoothstep(0.98, 0.82, se));
  // Inverted-heart nasal cavity.
  float nose = min(ell(q, vec2(0.024, 0.578), vec2(0.03, 0.03)), 99.0);
  float tri = sdTri(vec2(q.x, -(f.y - 0.548)) * vec2(1.0, 1.25), 0.034);
  float nasal = min(nose - 1.0, tri * 30.0);
  col = mix(col, vec3(0.02, 0.0, 0.0), smoothstep(0.15, -0.15, nasal));
  // Teeth across the lips with gaps.
  float band = ell(vec2(q.x, f.y), vec2(0.0, 0.695), vec2(0.14, 0.05));
  if (band < 1.0) {
    float gx = abs(fract(q.x / 0.026 + 0.5) - 0.5);
    float gap = max(smoothstep(0.1, 0.0, gx), smoothstep(0.0045, 0.0015, abs(f.y - 0.695)));
    vec3 tooth = vec3(0.92, 0.88, 0.74) * (0.5 + 0.6 * shade) * (1.0 - 0.25 * smoothstep(0.6, 1.0, band));
    col = mix(col, mix(tooth, vec3(0.08, 0.05, 0.03), gap), smoothstep(1.0, 0.92, band));
  }
  // Hairline cracks on the forehead.
  float crack = ridge(f * vec2(7.0, 5.0) + 2.0, 40.0) * smoothstep(0.32, 0.18, f.y);
  col = mix(col, vec3(0.15, 0.12, 0.1), crack * 0.8);
  return vec4(col, 1.0);
}

vec4 zombie(vec2 f, vec2 q, vec3 cam, float l) {
  vec3 skin = mix(vec3(l), cam, 0.25) * vec3(0.7, 0.86, 0.6) * 1.08;
  skin *= 0.78 + 0.4 * fbm(f * 9.0 + uSeed);
  skin = mix(skin, skin * vec3(0.7, 0.6, 0.82), smoothstep(0.55, 0.75, fbm(f * 5.0 + 3.0)));
  float veins = ridge(f * 9.0 + 11.0, 22.0) * smoothstep(0.18, 0.42, q.x);
  skin = mix(skin, vec3(0.24, 0.16, 0.33) * (0.4 + l), veins * 0.75);
  // Sunken, bruised eyes.
  float er = ell(q, vec2(0.155, 0.39), vec2(0.13, 0.095));
  skin = mix(skin * vec3(0.55, 0.42, 0.55), skin, smoothstep(0.55, 1.25, er));
  // Torn, rotting gash along the left cheek and jaw.
  vec2 wp = rot(0.45) * (f - vec2(0.655, 0.615));
  float wd = length(wp / vec2(0.09, 0.034)) + 0.7 * (fbm(f * 11.0 + 4.0) - 0.5) + 0.35 * (noise(f * 60.0) - 0.5);
  float rim = smoothstep(1.35, 1.0, wd) * (1.0 - smoothstep(1.0, 0.85, wd));
  float depth = smoothstep(1.0, 0.2, wd);
  vec3 flesh = mix(vec3(0.5, 0.06, 0.05), vec3(0.08, 0.0, 0.01), depth) * (0.6 + 0.9 * pow(fbm(f * 42.0), 1.4));
  flesh = mix(flesh, vec3(0.65, 0.12, 0.1), ridge(f * 30.0, 10.0) * (1.0 - depth) * 0.7); // torn sinew
  flesh *= 0.5 + 0.7 * l;
  flesh = mix(flesh, vec3(0.75, 0.62, 0.5) * (0.4 + 0.6 * l), smoothstep(0.62, 0.8, fbm(f * 25.0 + 9.0)) * 0.6); // bone peeking through
  flesh += vec3(0.45) * pow(fbm(f * 70.0 + uTime * 0.15), 7.0); // wet glint
  skin = mix(skin, vec3(0.12, 0.08, 0.04) * (0.6 + l), smoothstep(1.4, 1.05, wd) * 0.8);
  skin = mix(skin, flesh, smoothstep(1.0, 0.88, wd));
  skin += vec3(0.25, 0.05, 0.0) * rim * 0.4;
  // Scratches on the opposite cheek.
  float scratch = smoothstep(0.004, 0.0, abs(fract((f.x + f.y * 0.6) * 26.0) - 0.5) / 26.0) * step(0.5, fbm(f * 6.0)) * smoothstep(0.08, 0.0, ell(f, vec2(0.28, 0.6), vec2(0.08, 0.06)) - 0.92);
  skin = mix(skin, vec3(0.35, 0.03, 0.03), scratch * 0.8);
  // Rotten lips.
  float lips = ell(f, vec2(0.5, 0.695), vec2(0.125, 0.045));
  skin = mix(skin, vec3(0.2, 0.12, 0.16) * (0.5 + l), smoothstep(1.0, 0.75, lips) * 0.8);
  return vec4(skin, 1.0);
}

vec4 demon(vec2 f, vec2 q, vec3 cam, float l) {
  vec3 skin = vec3(0.6, 0.06, 0.03) * (0.22 + 1.15 * l);
  skin *= 0.85 + 0.3 * fbm(f * 16.0);
  float pulse = 0.65 + 0.35 * sin(uTime * 2.6 + f.y * 9.0);
  float lava = ridge(f * 5.5 + vec2(0.0, uTime * 0.03), 26.0);
  skin += vec3(1.0, 0.42, 0.05) * lava * pulse * 1.5;
  float er = ell(q, vec2(0.155, 0.385), vec2(0.13, 0.095));
  skin *= mix(0.12, 1.0, smoothstep(0.55, 1.3, er));
  // Heavy brow ridge.
  skin *= 1.0 - 0.45 * exp(-pow(ell(q, vec2(0.16, 0.285), vec2(0.13, 0.035)), 2.0));
  float lips = ell(f, vec2(0.5, 0.695), vec2(0.125, 0.045));
  skin = mix(skin, vec3(0.04, 0.0, 0.0), smoothstep(1.0, 0.7, lips));
  return vec4(skin, 1.0);
}

vec4 vampire(vec2 f, vec2 q, vec3 cam, float l) {
  vec3 pale = vec3(0.86, 0.88, 0.96) * (0.35 + 0.75 * l);
  vec3 skin = mix(cam, pale, 0.85);
  skin *= 1.0 - 0.3 * exp(-pow(ell(q, vec2(0.25, 0.62), vec2(0.07, 0.11)), 2.0)); // gaunt cheeks
  float er = ell(q, vec2(0.155, 0.39), vec2(0.12, 0.09));
  skin = mix(skin * vec3(0.5, 0.42, 0.6), skin, smoothstep(0.55, 1.2, er));
  float lips = ell(f, vec2(0.5, 0.695), vec2(0.125, 0.045));
  skin = mix(skin, vec3(0.42, 0.0, 0.04) * (0.45 + 0.9 * l), smoothstep(1.0, 0.75, lips));
  // Fang tips peeking below the upper lip.
  for (int s = -1; s <= 1; s += 2) {
    vec2 p = vec2(f.x - 0.5 - float(s) * 0.055, -(f.y - 0.715));
    float d = sdTri(vec2(p.x, -p.y) * vec2(1.0, 0.55), 0.011);
    skin = mix(skin, vec3(0.97, 0.95, 0.9) * (0.6 + 0.5 * l), smoothstep(0.002, -0.002, d));
  }
  // Two blood drips that slowly run to the chin and restart.
  for (int i = 0; i < 2; i++) {
    float x0 = i == 0 ? 0.455 : 0.565;
    float t0 = fract(uTime / 7.0 + float(i) * 0.43);
    float len = 0.04 + 0.2 * smoothstep(0.0, 0.85, t0);
    float y = f.y - 0.72;
    float wob = 0.003 * sin(y * 90.0 + float(i) * 3.0);
    float w = 0.006 * (1.0 - 0.5 * clamp(y / len, 0.0, 1.0)) + 0.004 * exp(-pow((y - len) / 0.01, 2.0));
    float drip = smoothstep(w, w * 0.4, abs(f.x - x0 - wob)) * step(0.0, y) * step(y, len + 0.008);
    drip *= 1.0 - smoothstep(0.85, 1.0, t0);
    vec3 blood = vec3(0.45, 0.0, 0.02) + vec3(0.5, 0.2, 0.2) * pow(smoothstep(w, 0.0, abs(f.x - x0 - wob + w * 0.4)), 8.0);
    skin = mix(skin, blood, drip);
  }
  return vec4(skin, 1.0);
}

vec4 possessed(vec2 f, vec2 q, vec3 cam, float l) {
  vec3 skin = vec3(pow(l, 1.15)) * vec3(0.82, 0.86, 0.95) * 1.05;
  vec2 crawl = vec2(fbm(f * 3.0 + uTime * 0.07), fbm(f * 3.0 - uTime * 0.05)) * 0.3;
  float veins = ridge(f * 8.0 + crawl * 4.0, 18.0);
  float near = max(smoothstep(1.9, 0.9, ell(q, vec2(0.155, 0.39), vec2(0.13, 0.1))), 1.0 - vFeather);
  near = max(near, smoothstep(1.8, 0.8, ell(f, vec2(0.5, 0.7), vec2(0.16, 0.08))));
  skin = mix(skin, vec3(0.02, 0.03, 0.08), veins * mix(0.35, 0.95, near));
  float er = ell(q, vec2(0.155, 0.39), vec2(0.125, 0.09));
  skin *= mix(0.08, 1.0, smoothstep(0.6, 1.25, er));
  // Black tears.
  for (int s = -1; s <= 1; s += 2) {
    float x0 = 0.5 + float(s) * 0.15 + 0.004 * sin(f.y * 60.0 + float(s));
    float y = f.y - 0.41;
    float len = 0.24 + 0.04 * sin(uTime * 0.6 + float(s));
    float w = 0.007 * (1.0 - 0.6 * clamp(y / len, 0.0, 1.0));
    float tear = smoothstep(w, w * 0.3, abs(f.x - x0)) * step(0.0, y) * smoothstep(len, len - 0.02, y);
    skin = mix(skin, vec3(0.0), tear);
  }
  float lips = ell(f, vec2(0.5, 0.695), vec2(0.125, 0.045));
  skin = mix(skin, vec3(0.03, 0.03, 0.06), smoothstep(1.0, 0.7, lips));
  return vec4(skin, 1.0);
}

vec4 wraith(vec2 f, vec2 q, vec3 cam, float l) {
  vec3 col = vec3(0.95, 0.95, 0.97) * (0.55 + 0.5 * smoothstep(0.05, 0.9, l));
  vec2 pe = rot(-0.35) * (q - vec2(0.15, 0.395));
  float eye = length(pe / vec2(0.06, 0.1)) + 0.25 * smoothstep(0.0, 0.1, pe.y);
  col = mix(col, vec3(0.0), smoothstep(1.02, 0.92, eye));
  col *= mix(0.65, 1.0, smoothstep(0.9, 1.6, eye));
  float nose = ell(q, vec2(0.018, 0.585), vec2(0.008, 0.016));
  col = mix(col, vec3(0.05), smoothstep(1.0, 0.7, nose));
  vec2 pm = vec2(q.x, f.y - 0.72);
  float mouth = length(pm / vec2(0.065 - 0.02 * pm.y / 0.12, 0.12));
  col = mix(col, vec3(0.0), smoothstep(1.02, 0.94, mouth));
  col *= mix(0.7, 1.0, smoothstep(0.95, 1.5, mouth));
  return vec4(col, 1.0);
}

float pumpkinCut(vec2 f, vec2 q) {
  float eyes = sdTri(vec2(q.x - 0.15, -(f.y - 0.39)), 0.075);
  float nose = sdTri(vec2(q.x, -(f.y - 0.555)), 0.035);
  // Jagged grin: between two curves, minus a couple of square teeth.
  float x = f.x - 0.5;
  float top = 0.655 - 0.25 * x * x - 0.012 * step(abs(x), 0.2) * step(0.5, fract(x / 0.08 + 0.25));
  float bot = 0.77 - 1.6 * x * x;
  float grin = max(max(top - f.y, f.y - bot), abs(x) - 0.25);
  float tooth = max(abs(abs(x) - 0.07) - 0.022, abs(f.y - top - 0.02) - 0.022);
  grin = max(grin, -tooth);
  return min(min(eyes, nose), grin);
}

vec4 pumpkin(vec2 f, vec2 q, vec3 cam, float l) {
  float rib = abs(cos((f.x - 0.5) * 3.14159 * 7.0));
  vec3 skin = vec3(1.0, 0.45, 0.04) * (0.25 + 0.95 * l) * (0.62 + 0.38 * pow(rib, 0.6));
  skin *= 0.85 + 0.25 * fbm(f * vec2(30.0, 6.0));
  float d = pumpkinCut(f, q);
  float flick = 0.8 + 0.2 * sin(uTime * 13.0) * sin(uTime * 7.3 + 1.0) + 0.1 * noise(vec2(uTime * 6.0, 0.0));
  // Hollow interior lit by a candle: hot yellow deep inside, deep orange near the cut wall.
  vec3 glow = mix(vec3(0.85, 0.28, 0.02), vec3(1.0, 0.86, 0.42), smoothstep(0.0, 0.035, -d)) * flick;
  vec3 flesh = vec3(0.98, 0.78, 0.38) * (0.45 + 0.5 * l);
  vec3 col = mix(skin, flesh, smoothstep(0.014, 0.006, d));
  col = mix(col, glow, smoothstep(0.003, -0.003, d));
  col += vec3(1.0, 0.45, 0.08) * 0.22 * flick * exp(-max(d, 0.0) * 55.0);
  return vec4(col, 1.0);
}

void main() {
  vec3 cam = texture(uCam, vScreen).rgb;
  float l = luma(cam);
  vec2 f = vFace;
  vec2 q = vec2(abs(f.x - 0.5), f.y);
  vec4 c;
  if (uFilter == 1) c = skull(f, q, cam, l);
  else if (uFilter == 2) c = zombie(f, q, cam, l);
  else if (uFilter == 3) c = demon(f, q, cam, l);
  else if (uFilter == 4) c = vampire(f, q, cam, l);
  else if (uFilter == 5) c = possessed(f, q, cam, l);
  else if (uFilter == 6) c = wraith(f, q, cam, l);
  else c = pumpkin(f, q, cam, l);
  float a = c.a * smoothstep(0.0, 1.0, vFeather) * uIntensity;
  o = vec4(c.rgb * a, a);
}
`;

/** Eye openings and the inner mouth: fan-triangulated contours; aEdge is 0 on the rim, 1 at the center. */
export const FEATURE_VS = /* glsl */ `${HEADER}
in vec2 aPos;
in float aEdge;
out vec2 vScreen;
out float vEdge;
void main() {
  vScreen = aPos;
  vEdge = aEdge;
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const EYE_FS = /* glsl */ `${HEADER}
${COMMON}
in vec2 vScreen;
in float vEdge;
uniform sampler2D uCam;
uniform int uFilter;
uniform vec2 uIris;     // uv
uniform float uIrisR;   // pixels
uniform vec2 uRes;
uniform float uTime, uIntensity;
out vec4 o;
void main() {
  vec3 cam = texture(uCam, vScreen).rgb;
  float l = luma(cam);
  vec2 d = (vScreen - uIris) * uRes / max(uIrisR, 1.0); // 1.0 = iris edge
  float r = length(d);
  vec3 col = cam;
  float a = 1.0;
  if (uFilter == 1) { // skull: void with an ember
    col = vec3(0.01, 0.0, 0.0) + vec3(1.0, 0.18, 0.02) * exp(-r * r * 3.5) * (0.8 + 0.2 * sin(uTime * 3.0));
  } else if (uFilter == 2) { // zombie: cataracts
    col = vec3(0.82, 0.86, 0.78) * (0.55 + 0.55 * l);
    col = mix(col, col * 0.78, smoothstep(1.1, 0.9, r) * 0.6);
  } else if (uFilter == 3) { // demon: burning slit eyes
    vec3 fire = mix(vec3(1.0, 0.25, 0.0), vec3(1.0, 0.9, 0.3), smoothstep(1.1, 0.2, r));
    col = mix(vec3(0.12, 0.0, 0.0), fire * 1.4, smoothstep(1.25, 0.95, r));
    float slit = length(d / vec2(0.22, 0.95));
    col = mix(col, vec3(0.0), smoothstep(1.05, 0.9, slit));
  } else if (uFilter == 4) { // vampire: blood-red irises
    col = mix(cam * vec3(1.0, 0.82, 0.82), vec3(0.85, 0.02, 0.05) * (0.5 + 0.9 * l) + vec3(0.25, 0.0, 0.0), smoothstep(1.05, 0.85, r));
    col = mix(col, vec3(0.0), smoothstep(0.42, 0.3, r));
  } else if (uFilter == 5) { // possessed: glossy black
    col = vec3(0.0) + vec3(0.9) * exp(-pow(length(d - vec2(-0.35, -0.4)) * 3.2, 2.0));
  } else if (uFilter == 6) {
    col = vec3(0.0);
  } else { // pumpkin: candle glow
    col = vec3(1.0, 0.7, 0.2) * (0.9 + 0.1 * sin(uTime * 13.0));
  }
  a = smoothstep(0.0, 0.35, vEdge) * uIntensity;
  o = vec4(col * a, a);
}
`;

export const MOUTH_FS = /* glsl */ `${HEADER}
${COMMON}
in vec2 vScreen;
in float vEdge;
uniform sampler2D uCam;
uniform int uFilter;
uniform vec2 uRes;
uniform vec2 uMouthL, uMouthR, uMouthTop, uMouthBot; // uv
uniform float uTime, uIntensity;
out vec4 o;
void main() {
  vec3 cam = texture(uCam, vScreen).rgb;
  float l = luma(cam);
  vec2 p = vScreen * uRes;
  vec2 L = uMouthL * uRes, R = uMouthR * uRes;
  vec2 mid = (L + R) * 0.5, axis = normalize(R - L);
  vec2 down = vec2(-axis.y, axis.x);
  float halfW = length(R - L) * 0.5;
  float open = max(dot((uMouthBot - uMouthTop) * uRes, down), 1.0);
  float x = dot(p - mid, axis) / halfW;              // -1..1 corner to corner
  float y = dot(p - uMouthTop * uRes, down) / open;  // 0 at upper lip, 1 at lower lip
  vec3 col;
  if (uFilter == 3) { // demon: fire inside
    float n = fbm(vec2(x * 3.0, y * 2.0 - uTime * 2.0));
    col = mix(vec3(0.6, 0.05, 0.0), vec3(1.0, 0.8, 0.25), n * smoothstep(0.0, 0.9, vEdge)) * 1.4;
  } else if (uFilter == 4) { // vampire: fangs over a dark red throat
    col = cam * vec3(0.35, 0.05, 0.06);
    for (int s = -1; s <= 1; s += 2) {
      float fx = x - float(s) * 0.42;
      float len = 0.75;
      float fang = step(abs(fx), 0.13 * (1.0 - y / len)) * step(y, len);
      col = mix(col, vec3(0.96, 0.94, 0.88) * (0.75 + 0.3 * (1.0 - y)), fang);
    }
  } else if (uFilter == 2) {
    col = cam * vec3(0.35, 0.18, 0.12);
  } else if (uFilter == 7) {
    col = mix(vec3(0.85, 0.28, 0.02), vec3(1.0, 0.8, 0.35), vEdge);
  } else {
    col = cam * 0.04;
  }
  float a = smoothstep(0.0, 0.3, vEdge) * uIntensity;
  o = vec4(col * a, a);
}
`;

export const HORN_VS = /* glsl */ `${HEADER}
in vec2 aPos;
in vec2 aHorn; // x: 0 base .. 1 tip, y: -1..1 across
out vec2 vHorn;
void main() {
  vHorn = aHorn;
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const HORN_FS = /* glsl */ `${HEADER}
${COMMON}
in vec2 vHorn;
uniform float uTime, uIntensity;
out vec4 o;
void main() {
  float t = vHorn.x, s = vHorn.y;
  float roundness = sqrt(max(0.0, 1.0 - s * s));
  float rings = 0.75 + 0.25 * smoothstep(0.2, 0.8, abs(fract(t * 11.0) - 0.5) * 2.0) * (1.0 - t);
  vec3 base = mix(vec3(0.16, 0.05, 0.03), vec3(0.05, 0.03, 0.03), t);
  vec3 col = base * (0.35 + 0.9 * roundness) * rings;
  col += vec3(0.9, 0.75, 0.6) * pow(max(0.0, 1.0 - abs(s + 0.4) * 2.2), 6.0) * 0.35; // specular
  col += vec3(1.0, 0.35, 0.05) * (1.0 - smoothstep(0.0, 0.25, t)) * (0.4 + 0.3 * sin(uTime * 2.6)); // lava base
  float a = smoothstep(1.0, 0.85, abs(s)) * uIntensity;
  o = vec4(col * a, a);
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
