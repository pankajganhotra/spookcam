// Face-anchored shaders: face paint, eyes, inner mouth, hair/fur halo and accessories.
//
// Realism model: every material is an *albedo* lit by the camera itself. uSkin samples a few
// skin points to find how bright "average skin" is right now; dividing the pixel's luminance by
// that gives relative shading (shadows < 1 < highlights) that works in any room or exposure.
// High-frequency camera detail (pores, wrinkles, stubble) is added back on top.
import { COMMON, HEADER } from './shaders';

/** Filter ids shared by every face program (kept in sync with renderer FILTER_IDS). */
export const FILTERS = {
  skull: 1, zombie: 2, demon: 3, vampire: 4, possessed: 5, wraith: 6, pumpkin: 7,
  clown: 8, slasher: 9, burned: 10, monster: 11, werewolf: 12, mummy: 13, witch: 14, doll: 15, onryo: 16,
} as const;

const LIGHTING = /* glsl */ `
uniform sampler2D uCam;
uniform vec2 uSkin[5];
uniform vec2 uTexel;
float skinRef() {
  float s = 0.0;
  for (int i = 0; i < 5; i++) s += luma(texture(uCam, uSkin[i]).rgb);
  return max(s / 5.0, 0.03);
}
`;

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
${LIGHTING}
in vec2 vFace;
in vec2 vScreen;
in float vFeather;
uniform int uFilter;
uniform float uTime, uIntensity, uSeed;
out vec4 o;

float gSh;       // pixel luminance relative to average skin
float gDetail;   // camera high-pass detail, relative to skin
float gHard;     // 0 = makeup that fades softly, 1 = rigid mask with a crisp edge

vec3 lit(vec3 albedo) {
  vec3 c = albedo * clamp(gSh, 0.05, 1.7);
  return c + gDetail * 0.85 * (0.3 + albedo);
}
/** Specular sheen wherever the real face is catching light. */
vec3 spec(float amount) {
  return vec3(pow(clamp((gSh - 1.0) / 0.6, 0.0, 1.0), 1.5) * amount);
}
float soft(float d, float w) { return smoothstep(w, -w, d); }

// UV anchors (canonical layout): eyes (±0.155, 0.378), brows y 0.257, nose base (0, 0.60),
// nostrils ±0.077, lips 0.653..0.737, mouth corners ±0.118, cheeks (±0.22, 0.55), chin 0.954.

vec3 skull(vec2 f, vec2 q, vec3 cam) {
  vec3 col = lit(vec3(0.93, 0.9, 0.82) * (0.85 + 0.15 * fbm(f * 22.0)));
  col *= 1.0 - 0.5 * exp(-pow(ell(q, vec2(0.215, 0.6), vec2(0.075, 0.075)), 2.0));
  col *= 1.0 - 0.35 * exp(-pow(ell(q, vec2(0.43, 0.3), vec2(0.09, 0.14)), 2.0));
  float se = ell(q, vec2(0.15, 0.385), vec2(0.105, 0.088)) + 0.08 * (fbm(f * 9.0) - 0.5);
  col *= mix(1.0, 0.4, smoothstep(1.45, 0.95, se));
  col = mix(col, vec3(0.012, 0.0, 0.0), smoothstep(0.98, 0.82, se));
  float nose = ell(q, vec2(0.024, 0.578), vec2(0.03, 0.03)) - 1.0;
  float tri = sdTri(vec2(q.x, -(f.y - 0.548)) * vec2(1.0, 1.25), 0.034) * 30.0;
  col = mix(col, vec3(0.02, 0.0, 0.0), smoothstep(0.15, -0.15, min(nose, tri)));
  float band = ell(vec2(q.x, f.y), vec2(0.0, 0.695), vec2(0.14, 0.05));
  if (band < 1.0) {
    float gx = abs(fract(q.x / 0.026 + 0.5) - 0.5);
    float gap = max(smoothstep(0.1, 0.0, gx), smoothstep(0.0045, 0.0015, abs(f.y - 0.695)));
    vec3 tooth = lit(vec3(0.92, 0.88, 0.74)) * (1.0 - 0.25 * smoothstep(0.6, 1.0, band));
    col = mix(col, mix(tooth, vec3(0.06, 0.04, 0.03), gap), smoothstep(1.0, 0.92, band));
  }
  float crack = ridge(f * vec2(7.0, 5.0) + 2.0, 40.0) * smoothstep(0.32, 0.18, f.y);
  col = mix(col, vec3(0.15, 0.12, 0.1), crack * 0.8);
  return col + spec(0.25);
}

vec3 zombie(vec2 f, vec2 q, vec3 cam) {
  vec3 alb = vec3(0.6, 0.7, 0.5) * (0.78 + 0.4 * fbm(f * 9.0 + uSeed));
  alb = mix(alb, alb * vec3(0.7, 0.6, 0.82), smoothstep(0.55, 0.75, fbm(f * 5.0 + 3.0)));
  float veins = ridge(f * 9.0 + 11.0, 22.0) * smoothstep(0.18, 0.42, q.x);
  alb = mix(alb, vec3(0.24, 0.16, 0.33), veins * 0.7);
  alb = mix(alb * vec3(0.5, 0.38, 0.5), alb, smoothstep(0.55, 1.25, ell(q, vec2(0.155, 0.39), vec2(0.13, 0.095))));
  vec3 skin = lit(alb);
  vec2 wp = rot(0.45) * (f - vec2(0.655, 0.615));
  float wd = length(wp / vec2(0.09, 0.034)) + 0.7 * (fbm(f * 11.0 + 4.0) - 0.5) + 0.35 * (noise(f * 60.0) - 0.5);
  float depth = smoothstep(1.0, 0.2, wd);
  vec3 flesh = mix(vec3(0.5, 0.06, 0.05), vec3(0.08, 0.0, 0.01), depth) * (0.6 + 0.9 * pow(fbm(f * 42.0), 1.4));
  flesh = mix(flesh, vec3(0.65, 0.12, 0.1), ridge(f * 30.0, 10.0) * (1.0 - depth) * 0.7);
  flesh = lit(flesh) + vec3(0.45) * pow(fbm(f * 70.0 + uTime * 0.15), 7.0);
  skin = mix(skin, lit(vec3(0.12, 0.08, 0.04)), smoothstep(1.4, 1.05, wd) * 0.8);
  skin = mix(skin, flesh, smoothstep(1.0, 0.88, wd));
  float lips = ell(f, vec2(0.5, 0.695), vec2(0.125, 0.045));
  skin = mix(skin, lit(vec3(0.22, 0.13, 0.18)), smoothstep(1.0, 0.75, lips) * 0.85);
  return skin + spec(0.15);
}

vec3 demon(vec2 f, vec2 q, vec3 cam) {
  vec3 alb = vec3(0.62, 0.07, 0.04) * (0.85 + 0.3 * fbm(f * 16.0));
  alb *= mix(0.15, 1.0, smoothstep(0.55, 1.3, ell(q, vec2(0.155, 0.385), vec2(0.13, 0.095))));
  alb *= 1.0 - 0.5 * exp(-pow(ell(q, vec2(0.16, 0.285), vec2(0.13, 0.035)), 2.0));
  float lips = ell(f, vec2(0.5, 0.695), vec2(0.125, 0.045));
  alb = mix(alb, vec3(0.03, 0.0, 0.0), smoothstep(1.0, 0.7, lips));
  vec3 col = lit(alb) + spec(0.35);
  float pulse = 0.65 + 0.35 * sin(uTime * 2.6 + f.y * 9.0);
  col += vec3(1.0, 0.42, 0.05) * ridge(f * 5.5 + vec2(0.0, uTime * 0.03), 26.0) * pulse * 1.4;
  return col;
}

vec3 vampire(vec2 f, vec2 q, vec3 cam) {
  vec3 alb = vec3(0.88, 0.88, 0.95);
  alb *= 1.0 - 0.3 * exp(-pow(ell(q, vec2(0.25, 0.62), vec2(0.07, 0.11)), 2.0));
  alb = mix(alb * vec3(0.5, 0.42, 0.6), alb, smoothstep(0.55, 1.2, ell(q, vec2(0.155, 0.39), vec2(0.12, 0.09))));
  vec3 col = lit(alb);
  float lips = ell(f, vec2(0.5, 0.695), vec2(0.125, 0.045));
  col = mix(col, lit(vec3(0.42, 0.0, 0.04)) + spec(0.5), smoothstep(1.0, 0.75, lips));
  for (int s = -1; s <= 1; s += 2) {
    vec2 p = vec2(f.x - 0.5 - float(s) * 0.055, f.y - 0.715);
    col = mix(col, lit(vec3(0.97, 0.95, 0.9)) + spec(0.4), smoothstep(0.002, -0.002, sdTri(p * vec2(1.0, 0.55), 0.011)));
  }
  for (int i = 0; i < 2; i++) {
    float x0 = i == 0 ? 0.455 : 0.565;
    float t0 = fract(uTime / 7.0 + float(i) * 0.43);
    float len = 0.04 + 0.2 * smoothstep(0.0, 0.85, t0);
    float y = f.y - 0.72;
    float wob = 0.003 * sin(y * 90.0 + float(i) * 3.0);
    float w = 0.006 * (1.0 - 0.5 * clamp(y / len, 0.0, 1.0)) + 0.004 * exp(-pow((y - len) / 0.01, 2.0));
    float drip = smoothstep(w, w * 0.4, abs(f.x - x0 - wob)) * step(0.0, y) * step(y, len + 0.008) * (1.0 - smoothstep(0.85, 1.0, t0));
    vec3 blood = lit(vec3(0.42, 0.0, 0.02)) + vec3(0.6, 0.3, 0.3) * pow(smoothstep(w, 0.0, abs(f.x - x0 - wob + w * 0.4)), 8.0);
    col = mix(col, blood, drip);
  }
  return col + spec(0.2);
}

vec3 possessed(vec2 f, vec2 q, vec3 cam) {
  vec3 alb = vec3(0.7, 0.72, 0.8);
  vec2 crawl = vec2(fbm(f * 3.0 + uTime * 0.07), fbm(f * 3.0 - uTime * 0.05)) * 0.3;
  float veins = ridge(f * 8.0 + crawl * 4.0, 18.0);
  float near = max(smoothstep(1.9, 0.9, ell(q, vec2(0.155, 0.39), vec2(0.13, 0.1))), 1.0 - vFeather);
  near = max(near, smoothstep(1.8, 0.8, ell(f, vec2(0.5, 0.7), vec2(0.16, 0.08))));
  alb = mix(alb, vec3(0.02, 0.03, 0.08), veins * mix(0.35, 0.95, near));
  alb *= mix(0.08, 1.0, smoothstep(0.6, 1.25, ell(q, vec2(0.155, 0.39), vec2(0.125, 0.09))));
  float lips = ell(f, vec2(0.5, 0.695), vec2(0.125, 0.045));
  alb = mix(alb, vec3(0.03, 0.03, 0.06), smoothstep(1.0, 0.7, lips));
  vec3 col = lit(alb);
  for (int s = -1; s <= 1; s += 2) {
    float x0 = 0.5 + float(s) * 0.15 + 0.004 * sin(f.y * 60.0 + float(s));
    float y = f.y - 0.41;
    float len = 0.24 + 0.04 * sin(uTime * 0.6 + float(s));
    float w = 0.007 * (1.0 - 0.6 * clamp(y / len, 0.0, 1.0));
    float tear = smoothstep(w, w * 0.3, abs(f.x - x0)) * step(0.0, y) * smoothstep(len, len - 0.02, y);
    col = mix(col, vec3(0.0) + spec(0.8), tear);
  }
  return col;
}

vec3 wraith(vec2 f, vec2 q, vec3 cam) {
  gHard = 0.7;
  vec3 col = lit(vec3(0.95, 0.95, 0.97)) + spec(0.5);
  vec2 pe = rot(-0.35) * (q - vec2(0.15, 0.395));
  float eye = length(pe / vec2(0.06, 0.1)) + 0.25 * smoothstep(0.0, 0.1, pe.y);
  col = mix(col, vec3(0.0), smoothstep(1.02, 0.92, eye));
  col *= mix(0.65, 1.0, smoothstep(0.9, 1.6, eye));
  col = mix(col, vec3(0.05), smoothstep(1.0, 0.7, ell(q, vec2(0.018, 0.585), vec2(0.008, 0.016))));
  vec2 pm = vec2(q.x, f.y - 0.72);
  float mouth = length(pm / vec2(0.065 - 0.02 * pm.y / 0.12, 0.12));
  col = mix(col, vec3(0.0), smoothstep(1.02, 0.94, mouth));
  col *= mix(0.7, 1.0, smoothstep(0.95, 1.5, mouth));
  return col;
}

float pumpkinCut(vec2 f, vec2 q) {
  float eyes = sdTri(vec2(q.x - 0.15, -(f.y - 0.39)), 0.075);
  float nose = sdTri(vec2(q.x, -(f.y - 0.555)), 0.035);
  float x = f.x - 0.5;
  float top = 0.655 - 0.25 * x * x - 0.012 * step(abs(x), 0.2) * step(0.5, fract(x / 0.08 + 0.25));
  float bot = 0.77 - 1.6 * x * x;
  float grin = max(max(top - f.y, f.y - bot), abs(x) - 0.25);
  float tooth = max(abs(abs(x) - 0.07) - 0.022, abs(f.y - top - 0.02) - 0.022);
  return min(min(eyes, nose), max(grin, -tooth));
}

vec3 pumpkin(vec2 f, vec2 q, vec3 cam) {
  float rib = abs(cos((f.x - 0.5) * 3.14159 * 7.0));
  vec3 col = lit(vec3(1.0, 0.45, 0.04) * (0.62 + 0.38 * pow(rib, 0.6)) * (0.85 + 0.25 * fbm(f * vec2(30.0, 6.0)))) + spec(0.3);
  float d = pumpkinCut(f, q);
  float flick = 0.8 + 0.2 * sin(uTime * 13.0) * sin(uTime * 7.3 + 1.0) + 0.1 * noise(vec2(uTime * 6.0, 0.0));
  vec3 glow = mix(vec3(0.85, 0.28, 0.02), vec3(1.0, 0.86, 0.42), smoothstep(0.0, 0.035, -d)) * flick;
  col = mix(col, lit(vec3(0.98, 0.78, 0.38)), smoothstep(0.014, 0.006, d));
  col = mix(col, glow, smoothstep(0.003, -0.003, d));
  return col + vec3(1.0, 0.45, 0.08) * 0.22 * flick * exp(-max(d, 0.0) * 55.0);
}

// ── Classic characters ──

vec3 clown(vec2 f, vec2 q, vec3 cam) {
  vec3 alb = vec3(0.96, 0.95, 0.93);
  alb = mix(alb, vec3(0.6, 0.55, 0.5), ridge(f * vec2(14.0, 11.0) + 5.0, 34.0) * 0.45); // cracked greasepaint
  vec2 d = q - vec2(0.155, 0.37);
  float dia = abs(d.x) / 0.055 + abs(d.y) / 0.16;
  alb = mix(alb, vec3(0.1, 0.25, 0.75), smoothstep(1.03, 0.95, dia));
  float brow = abs(length((q - vec2(0.165, 0.34)) / vec2(1.0, 0.75)) - 0.12);
  alb = mix(alb, vec3(0.04), smoothstep(0.007, 0.003, brow) * step(f.y, 0.31));
  // Red lips swept into a too-wide grin that climbs the cheeks.
  float lips = ell(vec2(q.x, f.y), vec2(0.0, 0.698), vec2(0.15, 0.055));
  float x = q.x;
  float curve = 0.712 - 3.2 * pow(max(x - 0.1, 0.0), 2.0);
  float w = 0.026 * (1.0 - smoothstep(0.1, 0.27, x)) + 0.005;
  float smile = max(smoothstep(1.0, 0.92, lips), smoothstep(w, w * 0.6, abs(f.y - curve)) * smoothstep(0.08, 0.1, x) * smoothstep(0.28, 0.26, x));
  smile *= 0.85 + 0.15 * fbm(f * 40.0); // smudged
  alb = mix(alb, vec3(0.72, 0.02, 0.05), smile);
  return lit(alb) + spec(0.35);
}

vec3 slasher(vec2 f, vec2 q, vec3 cam) {
  gHard = 1.0;
  vec3 alb = vec3(0.87, 0.85, 0.78) * (0.9 + 0.1 * fbm(f * 30.0));
  alb = mix(alb, vec3(0.42, 0.35, 0.25), smoothstep(0.55, 0.85, fbm(f * 6.0 + 2.0)) * 0.55); // grime
  alb = mix(alb, vec3(0.35, 0.05, 0.04), smoothstep(0.7, 0.85, fbm(f * 9.0 + 13.0)) * 0.5); // old blood
  // Red chevrons on the forehead and cheeks.
  float chev = min(sdTri(rot(0.5) * (vec2(q.x, f.y) - vec2(0.09, 0.24)) * vec2(1.0, -1.0), 0.03),
                   sdTri(rot(-0.3) * (vec2(q.x, f.y) - vec2(0.24, 0.49)) * vec2(1.0, -1.0), 0.028));
  alb = mix(alb, vec3(0.7, 0.04, 0.04), smoothstep(0.002, -0.002, chev) * (0.8 + 0.2 * fbm(f * 50.0)));
  vec3 col = lit(alb) + spec(0.7);
  // Scuffs catch light.
  col += vec3(0.25) * ridge(f * vec2(30.0, 4.0) + 3.0, 60.0) * 0.4;
  // Vent holes: rows on the cheeks, forehead and chin.
  float holes = 1.0;
  for (int i = 0; i < 3; i++) for (int j = 0; j < 3; j++) {
    float fi = float(i), fj = float(j);
    holes = min(holes, length(vec2(q.x, f.y) - vec2(0.06 + 0.055 * fj, 0.52 + 0.06 * fi)) - 0.012);
    holes = min(holes, length(vec2(q.x, f.y) - vec2(0.03 + 0.06 * fj, 0.13 + 0.045 * fi)) - 0.01);
  }
  holes = min(holes, length(vec2(q.x, f.y) - vec2(0.035, 0.82)) - 0.011);
  holes = min(holes, length(vec2(q.x, f.y) - vec2(0.0, 0.88)) - 0.011);
  col = mix(col, cam * 0.18, smoothstep(0.002, -0.002, holes));
  col *= mix(0.6, 1.0, smoothstep(0.0, 0.008, holes)); // bevel shadow
  float eye = length((q - vec2(0.155, 0.385)) / vec2(0.09, 0.06));
  col = mix(col, cam * 0.3, smoothstep(1.02, 0.95, eye));
  col *= mix(0.55, 1.0, smoothstep(1.0, 1.25, eye));
  return col;
}

vec3 burned(vec2 f, vec2 q, vec3 cam) {
  float n1 = fbm(f * 7.0);
  float rid = ridge(f * vec2(9.0, 13.0) + 1.3, 6.0);
  float melt = fbm(f * vec2(4.0, 16.0) + n1);
  vec3 alb = mix(vec3(0.5, 0.23, 0.18), vec3(0.76, 0.36, 0.33), smoothstep(0.45, 0.7, melt));
  alb = mix(alb, vec3(0.14, 0.07, 0.05), smoothstep(0.62, 0.8, fbm(f * 11.0 + 7.0)) * 0.8);
  alb *= 0.78 + 0.42 * rid;
  // Melted-scar relief from the ridge field.
  float e = 0.004;
  float rx = ridge(f * vec2(9.0, 13.0) + 1.3 + vec2(e * 9.0, 0.0), 6.0) - rid;
  float ry = ridge(f * vec2(9.0, 13.0) + 1.3 + vec2(0.0, e * 13.0), 6.0) - rid;
  vec3 col = lit(alb) * (1.0 - (rx + ry) * 2.5);
  col += vec3(1.0, 0.85, 0.8) * pow(max(0.0, rid - 0.55) / 0.45, 3.0) * 0.3 * clamp(gSh, 0.0, 1.5); // wet sheen
  col = mix(col, lit(vec3(0.6, 0.12, 0.12)), smoothstep(1.4, 1.0, ell(q, vec2(0.155, 0.385), vec2(0.11, 0.07))) * 0.6);
  float lips = ell(f, vec2(0.5, 0.695), vec2(0.12, 0.04));
  return mix(col, lit(vec3(0.35, 0.12, 0.1)), smoothstep(1.0, 0.75, lips));
}

float segDist(vec2 p, vec2 a, vec2 b, out float t) {
  vec2 pa = p - a, ba = b - a;
  t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * t);
}

vec3 stitches(vec3 col, vec2 f, vec2 a, vec2 b) {
  float t;
  float d = segDist(f, a, b, t);
  float scar = smoothstep(0.006, 0.002, d);
  vec3 c = mix(col, col * vec3(0.55, 0.3, 0.3), smoothstep(0.016, 0.004, d) * 0.6); // inflamed rim
  c = mix(c, vec3(0.2, 0.05, 0.05), scar);
  float len = length(b - a);
  float k = abs(fract(t * len / 0.03) - 0.5) * 0.03;
  float stitch = smoothstep(0.003, 0.0012, k) * smoothstep(0.022, 0.012, d);
  return mix(c, vec3(0.03), stitch);
}

vec3 monster(vec2 f, vec2 q, vec3 cam) {
  vec3 alb = vec3(0.5, 0.6, 0.46) * (0.85 + 0.3 * fbm(f * 8.0));
  alb *= mix(0.3, 1.0, smoothstep(0.5, 1.25, ell(q, vec2(0.155, 0.37), vec2(0.13, 0.1))));
  alb *= 1.0 - 0.4 * exp(-pow(ell(q, vec2(0.15, 0.275), vec2(0.16, 0.035)), 2.0));
  float lips = ell(f, vec2(0.5, 0.695), vec2(0.125, 0.045));
  alb = mix(alb, vec3(0.22, 0.2, 0.24), smoothstep(1.0, 0.75, lips));
  vec3 col = lit(alb) + spec(0.1);
  col = stitches(col, f + vec2(0.0, 0.008 * sin(f.x * 25.0)), vec2(0.22, 0.2), vec2(0.78, 0.2));
  col = stitches(col, f, vec2(0.73, 0.47), vec2(0.66, 0.66));
  // Square-cut black fringe.
  float fringe = 0.085 + 0.012 * noise(vec2(f.x * 40.0, 0.0));
  vec3 hair = lit(vec3(0.03, 0.028, 0.025) + vec3(0.06) * pow(noise(vec2(f.x * 180.0, f.y * 6.0)), 3.0));
  return mix(col, hair, smoothstep(fringe + 0.006, fringe - 0.006, f.y));
}

vec3 werewolf(vec2 f, vec2 q, vec3 cam) {
  vec2 dir = normalize(f - vec2(0.5, 0.6) + vec2(1e-4));
  float along = dot(f, dir), across = dot(f, vec2(-dir.y, dir.x));
  float strands = noise(vec2(across * 160.0, along * 14.0)) * 0.6 + noise(vec2(across * 380.0, along * 30.0)) * 0.4;
  vec3 fur = mix(vec3(0.18, 0.12, 0.08), vec3(0.55, 0.45, 0.33), strands);
  float muzzle = smoothstep(1.25, 0.6, ell(f, vec2(0.5, 0.65), vec2(0.17, 0.13)));
  fur = mix(fur, mix(vec3(0.5, 0.42, 0.33), vec3(0.78, 0.7, 0.6), strands), muzzle * 0.8);
  fur *= mix(0.5, 1.0, smoothstep(0.6, 1.3, ell(q, vec2(0.155, 0.38), vec2(0.12, 0.08))));
  fur *= 1.0 - 0.45 * exp(-pow(ell(q, vec2(0.15, 0.29), vec2(0.15, 0.04)), 2.0));
  float nose = ell(f, vec2(0.5, 0.57), vec2(0.06, 0.038));
  fur = mix(fur, vec3(0.025), smoothstep(1.0, 0.8, nose));
  float lips = ell(f, vec2(0.5, 0.7), vec2(0.13, 0.045));
  fur = mix(fur, vec3(0.04, 0.03, 0.03), smoothstep(1.0, 0.75, lips));
  return lit(fur) + spec(0.8) * smoothstep(1.0, 0.8, nose); // wet nose
}

vec3 mummy(vec2 f, vec2 q, vec3 cam) {
  // Overlapping linen wraps: alternate bands tilt opposite ways, edges frayed, deep shadowed gaps.
  float s0 = f.y * 9.0 + 0.5 * sin(f.x * 4.0 + 1.0);
  float tilt = mod(floor(s0), 2.0) < 1.0 ? 0.9 : -0.9;
  float s = f.y * 9.0 + tilt * (f.x - 0.5) + 0.5 * sin(f.x * 4.0 + floor(s0));
  float id = floor(s), fr = fract(s);
  float fray = 0.06 * noise(vec2(f.x * 120.0, id * 7.0));
  float cloth = smoothstep(0.05 + fray, 0.14 + fray, fr) * smoothstep(0.97 - fray, 0.88 - fray, fr);
  float fiber = noise(vec2(f.x * 260.0 + id * 3.0, s * 4.0)) * 0.6 + noise(vec2(f.x * 600.0, s * 9.0)) * 0.4;
  vec3 linen = vec3(0.92, 0.88, 0.77) * (0.82 + 0.25 * fiber);
  linen = mix(linen, vec3(0.5, 0.4, 0.27), smoothstep(0.55, 0.85, fbm(f * 5.0 + id)) * 0.65); // age stains
  linen = mix(linen, vec3(0.38, 0.12, 0.08), smoothstep(0.78, 0.9, fbm(f * 8.0 + 31.0)) * 0.5);  // old blood
  linen *= 0.62 + 0.38 * sin(fr * 3.1416);                                                      // rounded wrap
  vec3 col = mix(vec3(0.02, 0.015, 0.01), lit(linen), cloth);
  float eye = ell(q, vec2(0.155, 0.385), vec2(0.1, 0.045)) + 0.25 * (fbm(f * 20.0) - 0.5);
  col = mix(col, cam * 0.3, smoothstep(1.0, 0.85, eye));
  return col;
}

float wart(vec2 p) {
  vec2 g = floor(p);
  float h = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 c = g + vec2(float(x), float(y));
    vec2 r = hash22(c);
    if (hash12(c + 9.1) > 0.12) continue;
    float d = length(p - c - r) / (0.25 + 0.2 * r.x);
    h = max(h, 1.0 - smoothstep(0.0, 1.0, d * d));
  }
  return h;
}

vec3 witch(vec2 f, vec2 q, vec3 cam) {
  vec3 alb = vec3(0.4, 0.58, 0.27) * (0.85 + 0.3 * fbm(f * 10.0));
  alb *= mix(0.45, 1.0, smoothstep(0.55, 1.3, ell(q, vec2(0.155, 0.385), vec2(0.13, 0.095))));
  alb = mix(alb, vec3(0.3, 0.12, 0.3), smoothstep(1.3, 0.8, ell(q, vec2(0.155, 0.385), vec2(0.13, 0.095))) * 0.3);
  float lips = ell(f, vec2(0.5, 0.695), vec2(0.125, 0.045));
  alb = mix(alb, vec3(0.08, 0.03, 0.08), smoothstep(1.0, 0.75, lips));
  vec2 wp = f * 26.0;
  float h = max(wart(wp), max(1.0 - smoothstep(0.0, 1.0, pow(ell(f, vec2(0.455, 0.545), vec2(0.018, 0.018)), 2.0)),
                               1.0 - smoothstep(0.0, 1.0, pow(ell(f, vec2(0.54, 0.87), vec2(0.022, 0.02)), 2.0))));
  float hx = wart(wp + vec2(0.08, 0.0)) - wart(wp - vec2(0.08, 0.0));
  float hy = wart(wp + vec2(0.0, 0.08)) - wart(wp - vec2(0.0, 0.08));
  alb = mix(alb, alb * vec3(0.85, 0.75, 0.55), h);
  vec3 col = lit(alb) * (1.0 - (hx + hy) * 0.6) + spec(0.15);
  return col + vec3(0.12) * h * clamp(gSh, 0.0, 1.4) * smoothstep(0.2, -0.3, hx + hy);
}

vec3 doll(vec2 f, vec2 q, vec3 cam) {
  gHard = 0.55;
  vec3 alb = vec3(0.97, 0.94, 0.9);
  alb = mix(alb, vec3(0.95, 0.55, 0.6), exp(-pow(length((q - vec2(0.2, 0.56)) / 0.065), 2.0)) * 0.8);
  float lips = ell(vec2(q.x * 1.5 + 0.02 * smoothstep(0.66, 0.7, f.y), f.y), vec2(0.0, 0.7), vec2(0.075, 0.032));
  alb = mix(alb, vec3(0.78, 0.06, 0.14), smoothstep(1.0, 0.9, lips));
  float brow = abs(length((q - vec2(0.16, 0.33)) / vec2(1.0, 0.7)) - 0.1);
  alb = mix(alb, vec3(0.35, 0.2, 0.12), smoothstep(0.004, 0.0015, brow) * step(f.y, 0.3));
  for (int i = 0; i < 4; i++) {
    float x0 = 0.115 + 0.03 * float(i);
    float lash = smoothstep(0.003, 0.001, abs(q.x - x0 - (f.y - 0.415) * 0.3)) * step(0.415, f.y) * step(f.y, 0.44);
    alb = mix(alb, vec3(0.1), lash);
  }
  vec3 col = lit(alb);
  col += spec(0.9) + vec3(0.06) * smoothstep(0.4, 0.0, length(q - vec2(0.1, 0.18)));
  // A crack running down through one eye, with chipped edges.
  float cx = 0.62 + 0.04 * sin(f.y * 9.0) + 0.09 * f.y + 0.006 * (noise(f * 70.0) - 0.5);
  float d = abs(f.x - cx);
  float reach = step(f.y, 0.64);
  float chip = smoothstep(0.012, 0.004, d) * step(0.6, noise(vec2(f.y * 30.0, 2.0))) * reach;
  col = mix(col, lit(vec3(0.55, 0.5, 0.45)), chip);
  col = mix(col, vec3(0.03), smoothstep(0.0028, 0.0008, d) * reach);
  float t;
  float b = segDist(f, vec2(cx, 0.22), vec2(0.72, 0.3), t);
  return mix(col, vec3(0.04), smoothstep(0.002, 0.0006, b + 0.002 * noise(f * 90.0)));
}

vec3 onryo(vec2 f, vec2 q, vec3 cam) {
  vec3 alb = vec3(0.76, 0.79, 0.84) * (0.92 + 0.12 * fbm(f * 12.0));
  alb = mix(alb, vec3(0.45, 0.5, 0.65), ridge(f * 7.0 + 21.0, 30.0) * smoothstep(0.2, 0.4, q.x) * 0.5);
  alb = mix(alb * vec3(0.4, 0.38, 0.45), alb, smoothstep(0.55, 1.3, ell(q, vec2(0.155, 0.385), vec2(0.13, 0.1))));
  float lips = ell(f, vec2(0.5, 0.695), vec2(0.125, 0.045));
  alb = mix(alb, vec3(0.42, 0.42, 0.5), smoothstep(1.0, 0.75, lips));
  vec3 col = lit(alb);
  // Wet strands stuck across the face.
  float sx = f.x + 0.02 * sin(f.y * 12.0 + f.x * 5.0);
  float strand = smoothstep(0.62, 0.8, noise(vec2(sx * 55.0, f.y * 1.5))) * smoothstep(0.75, 0.15, f.y) * (0.4 + 0.6 * smoothstep(0.05, 0.25, q.x));
  return mix(col, vec3(0.012) + spec(0.35), strand);
}

void main() {
  vec3 cam = texture(uCam, vScreen).rgb;
  float l = luma(cam);
  float ref = skinRef();
  vec2 o3 = uTexel * 2.5;
  float blur = 0.25 * (luma(texture(uCam, vScreen + vec2(o3.x, 0.0)).rgb) + luma(texture(uCam, vScreen - vec2(o3.x, 0.0)).rgb)
                     + luma(texture(uCam, vScreen + vec2(0.0, o3.y)).rgb) + luma(texture(uCam, vScreen - vec2(0.0, o3.y)).rgb));
  gSh = l / ref;
  gDetail = clamp((l - blur) / ref, -0.35, 0.35);
  gHard = 0.0;
  vec2 f = vFace;
  vec2 q = vec2(abs(f.x - 0.5), f.y);
  vec3 c;
  if (uFilter == 1) c = skull(f, q, cam);
  else if (uFilter == 2) c = zombie(f, q, cam);
  else if (uFilter == 3) c = demon(f, q, cam);
  else if (uFilter == 4) c = vampire(f, q, cam);
  else if (uFilter == 5) c = possessed(f, q, cam);
  else if (uFilter == 6) c = wraith(f, q, cam);
  else if (uFilter == 7) c = pumpkin(f, q, cam);
  else if (uFilter == 8) c = clown(f, q, cam);
  else if (uFilter == 9) c = slasher(f, q, cam);
  else if (uFilter == 10) c = burned(f, q, cam);
  else if (uFilter == 11) c = monster(f, q, cam);
  else if (uFilter == 12) c = werewolf(f, q, cam);
  else if (uFilter == 13) c = mummy(f, q, cam);
  else if (uFilter == 14) c = witch(f, q, cam);
  else if (uFilter == 15) c = doll(f, q, cam);
  else c = onryo(f, q, cam);
  float a = mix(smoothstep(0.0, 1.0, vFeather), smoothstep(0.3, 0.42, vFeather), gHard) * uIntensity;
  o = vec4(clamp(c, 0.0, 4.0) * a, a);
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
${LIGHTING}
in vec2 vScreen;
in float vEdge;
uniform int uFilter;
uniform vec2 uIris;     // uv
uniform float uIrisR;   // pixels
uniform vec2 uRes;
uniform float uTime, uIntensity;
out vec4 o;

/** Replace the iris colour but keep the camera's pupil, lashes and reflections. */
vec3 tintIris(vec3 cam, float r, vec3 iris, float l, float pupil) {
  vec3 c = mix(cam, iris * (0.45 + 0.9 * l / max(skinRef(), 0.05)), smoothstep(1.05, 0.85, r));
  c = mix(c, vec3(0.0), smoothstep(pupil + 0.08, pupil - 0.04, r));
  return c;
}
float glints(float l) { return smoothstep(0.72, 0.95, l); }

void main() {
  vec3 cam = texture(uCam, vScreen).rgb;
  float l = luma(cam);
  vec2 d = (vScreen - uIris) * uRes / max(uIrisR, 1.0); // 1.0 = iris edge
  float r = length(d);
  vec3 col = cam;
  float a = 1.0;
  if (uFilter == 1) {
    col = vec3(0.01, 0.0, 0.0) + vec3(1.0, 0.18, 0.02) * exp(-r * r * 3.5) * (0.8 + 0.2 * sin(uTime * 3.0));
  } else if (uFilter == 2) {
    col = vec3(0.82, 0.86, 0.78) * (0.55 + 0.55 * l);
    col = mix(col, col * 0.78, smoothstep(1.1, 0.9, r) * 0.6) + glints(l) * 0.5;
  } else if (uFilter == 3) {
    vec3 fire = mix(vec3(1.0, 0.25, 0.0), vec3(1.0, 0.9, 0.3), smoothstep(1.1, 0.2, r));
    col = mix(vec3(0.12, 0.0, 0.0), fire * 1.4, smoothstep(1.25, 0.95, r));
    col = mix(col, vec3(0.0), smoothstep(1.05, 0.9, length(d / vec2(0.22, 0.95))));
  } else if (uFilter == 4) {
    col = tintIris(cam * vec3(1.0, 0.85, 0.85), r, vec3(0.9, 0.02, 0.05), l, 0.32) + glints(l) * 0.6;
  } else if (uFilter == 5) {
    col = vec3(0.0) + vec3(0.9) * exp(-pow(length(d - vec2(-0.35, -0.4)) * 3.2, 2.0)) + glints(l) * 0.3;
  } else if (uFilter == 6) {
    col = vec3(0.0);
  } else if (uFilter == 7) {
    col = vec3(1.0, 0.7, 0.2) * (0.9 + 0.1 * sin(uTime * 13.0));
  } else if (uFilter == 8) { // clown: sickly yellow irises
    col = tintIris(cam, r, vec3(0.95, 0.75, 0.1), l, 0.3) + glints(l) * 0.6;
  } else if (uFilter == 9) {
    col = cam * 0.3;
  } else if (uFilter == 10) {
    col = mix(cam, cam * vec3(1.15, 0.7, 0.7), smoothstep(0.9, 1.4, r));
  } else if (uFilter == 11) {
    col = mix(vec3(luma(cam)), cam, 0.3) * 0.8 + glints(l) * 0.4;
  } else if (uFilter == 12) { // werewolf: amber glow
    col = tintIris(cam, r, vec3(1.0, 0.62, 0.05) * 1.3, max(l, 0.5), 0.42) + glints(l) * 0.5;
    col = mix(col, cam * 0.5, smoothstep(1.1, 1.5, r));
  } else if (uFilter == 13) {
    col = cam * 0.25 + vec3(0.3, 0.25, 0.1) * exp(-r * r * 6.0) * 0.6;
  } else if (uFilter == 14) { // witch: green slit irises
    col = tintIris(cam, r, vec3(0.45, 0.9, 0.15), max(l, 0.4), 0.0);
    col = mix(col, vec3(0.0), smoothstep(1.05, 0.9, length(d / vec2(0.18, 0.9))));
    col += glints(l) * 0.5;
  } else if (uFilter == 15) { // doll: glass eyes
    float ang = atan(d.y, d.x);
    vec3 iris = mix(vec3(0.15, 0.35, 0.75), vec3(0.45, 0.7, 0.95), noise(vec2(ang * 12.0, r * 3.0)));
    col = mix(vec3(0.95, 0.94, 0.92) * (0.6 + 0.4 * l / 0.6), iris * (0.7 + 0.3 * (1.0 - r)), smoothstep(1.25, 1.1, r));
    col = mix(col, vec3(0.01), smoothstep(0.5, 0.42, r));
    col += vec3(1.0) * exp(-pow(length(d - vec2(-0.35, -0.45)) * 4.0, 2.0));
  } else { // onryo: shrunken pupils in bloodshot whites
    col = mix(vec3(0.92, 0.88, 0.86) * (0.5 + 0.6 * l), cam * 0.3, 0.15);
    col = mix(col, vec3(0.7, 0.1, 0.1), ridge(d * 1.6 + 3.0, 30.0) * smoothstep(0.6, 1.6, r) * 0.6);
    col = mix(col, vec3(0.45, 0.45, 0.42), smoothstep(0.55, 0.45, r) * 0.5);
    col = mix(col, vec3(0.0), smoothstep(0.28, 0.2, r)) + glints(l) * 0.4;
  }
  a = smoothstep(0.0, 0.35, vEdge) * uIntensity;
  o = vec4(col * a, a);
}
`;

export const MOUTH_FS = /* glsl */ `${HEADER}
${COMMON}
${LIGHTING}
in vec2 vScreen;
in float vEdge;
uniform int uFilter;
uniform vec2 uRes;
uniform vec2 uMouthL, uMouthR, uMouthTop, uMouthBot; // uv
uniform float uTime, uIntensity;
out vec4 o;

/** Row of pointed teeth hanging from y=0 (upper) or rising from y=1 (lower). */
float teeth(float x, float y, float count, float len, bool upper) {
  float cell = abs(fract(x * count * 0.5 + 0.5) - 0.5) * 2.0; // 0 at tooth center
  float h = len * (1.0 - cell);
  return upper ? step(y, h) : step(1.0 - h, y);
}

void main() {
  vec3 cam = texture(uCam, vScreen).rgb;
  vec2 p = vScreen * uRes;
  vec2 L = uMouthL * uRes, R = uMouthR * uRes;
  vec2 mid = (L + R) * 0.5, axis = normalize(R - L);
  vec2 down = vec2(-axis.y, axis.x);
  float halfW = length(R - L) * 0.5;
  float open = max(dot((uMouthBot - uMouthTop) * uRes, down), 1.0);
  float x = dot(p - mid, axis) / halfW;
  float y = dot(p - uMouthTop * uRes, down) / open;
  float sh = clamp(luma(cam) / skinRef(), 0.2, 1.5);
  vec3 col = cam * 0.04;
  float a = 1.0;
  vec3 ivory = vec3(0.95, 0.92, 0.82) * (0.55 + 0.45 * sh);
  if (uFilter == 3) {
    float n = fbm(vec2(x * 3.0, y * 2.0 - uTime * 2.0));
    col = mix(vec3(0.6, 0.05, 0.0), vec3(1.0, 0.8, 0.25), n * smoothstep(0.0, 0.9, vEdge)) * 1.4;
  } else if (uFilter == 4) {
    col = cam * vec3(0.35, 0.05, 0.06);
    for (int s = -1; s <= 1; s += 2) {
      float fx = x - float(s) * 0.42;
      col = mix(col, ivory, step(abs(fx), 0.13 * (1.0 - y / 0.75)) * step(y, 0.75));
    }
  } else if (uFilter == 2 || uFilter == 10) {
    col = cam * vec3(0.35, 0.18, 0.12);
  } else if (uFilter == 7) {
    col = mix(vec3(0.85, 0.28, 0.02), vec3(1.0, 0.8, 0.35), vEdge);
  } else if (uFilter == 8) { // clown: rows of needle teeth
    col = vec3(0.12, 0.0, 0.01);
    float t = max(teeth(x, y, 9.0, 0.45, true), teeth(x + 0.1, y, 8.0, 0.4, false));
    col = mix(col, ivory * vec3(1.0, 0.95, 0.75), t);
  } else if (uFilter == 9) { // the mask covers the mouth
    col = vec3(0.86, 0.84, 0.77) * 0.85 * (0.9 + 0.1 * noise(vScreen * 900.0));
  } else if (uFilter == 13) { // bandaged over
    float fr = fract(y * 2.2 + x * 0.3);
    col = mix(vec3(0.03), vec3(0.86, 0.81, 0.68) * 0.85 * (0.72 + 0.28 * sin(fr * 3.1416)), smoothstep(0.0, 0.15, fr) * smoothstep(1.0, 0.85, fr));
  } else if (uFilter == 12) { // werewolf: fangs top and bottom
    col = vec3(0.18, 0.02, 0.03) * sh;
    float t = max(teeth(x, y, 7.0, 0.3, true), teeth(x, y, 7.0, 0.25, false));
    for (int s = -1; s <= 1; s += 2) t = max(t, step(abs(x - float(s) * 0.55), 0.12 * (1.0 - y / 0.7)) * step(y, 0.7));
    col = mix(col, ivory, t);
  } else if (uFilter == 14) {
    col = vec3(0.05, 0.02, 0.02);
    col = mix(col, ivory * vec3(0.9, 0.85, 0.55), teeth(x * 0.6 + 0.2, y, 3.0, 0.35, true) * step(0.1, abs(x)));
  }
  a *= smoothstep(0.0, 0.3, vEdge) * uIntensity;
  o = vec4(col * a, a);
}
`;

/** Hair / fur / bandage ring around the head; aRad 0 at the face edge, 1 at the outer edge. */
export const HALO_VS = /* glsl */ `${HEADER}
in vec2 aPos;
in float aRad;
in vec2 aDir; // (side, up) unit direction of this spoke in face space
out vec2 vScreen;
out float vRad;
out vec2 vDir;
void main() {
  vScreen = aPos;
  vRad = aRad;
  vDir = aDir;
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const HALO_FS = /* glsl */ `${HEADER}
${COMMON}
${LIGHTING}
in vec2 vScreen;
in float vRad;
in vec2 vDir;
uniform int uFilter;
uniform float uTime, uIntensity;
out vec4 o;
void main() {
  float ang = atan(vDir.x, vDir.y); // 0 = up
  vec3 cam = texture(uCam, vScreen).rgb;
  float sh = clamp(luma(cam) / skinRef(), 0.25, 1.4);
  float s1 = noise(vec2(ang * 90.0, vRad * 3.0));
  float s2 = noise(vec2(ang * 230.0, vRad * 1.5));
  float tips = 0.6 + 0.4 * noise(vec2(ang * 22.0, 3.0));
  float a = smoothstep(tips, tips - 0.3, vRad);
  vec3 col;
  if (uFilter == 8) { // clown: frizzy orange-red tufts
    float curls = noise(vec2(ang * 40.0, vRad * 9.0)) * 0.6 + s2 * 0.4;
    col = mix(vec3(0.55, 0.08, 0.02), vec3(0.95, 0.35, 0.05), curls);
    a = smoothstep(0.55 + 0.45 * curls, 0.35 + 0.3 * curls, vRad) * smoothstep(0.35, 0.7, abs(vDir.x));
  } else if (uFilter == 11) { // monster: flat-top black hair
    col = vec3(0.03, 0.028, 0.025) + vec3(0.07) * pow(s2, 3.0);
    a = smoothstep(1.0, 0.92, vRad);
  } else if (uFilter == 12) { // werewolf mane
    col = mix(vec3(0.16, 0.11, 0.07), vec3(0.5, 0.42, 0.32), s1 * 0.65 + s2 * 0.35);
    col *= 0.7 + 0.3 * (1.0 - vRad);
  } else if (uFilter == 13) { // mummy: wraps continue around the head
    float s = vRad * 2.5 + ang * 1.3;
    float fr = fract(s);
    vec3 linen = vec3(0.8, 0.74, 0.6) * (0.85 + 0.15 * noise(vec2(ang * 200.0, s * 3.0)));
    linen = mix(linen, vec3(0.45, 0.36, 0.24), smoothstep(0.55, 0.85, fbm(vec2(ang * 3.0, vRad * 4.0))) * 0.6);
    col = mix(vec3(0.02), linen * (0.72 + 0.28 * sin(fr * 3.1416)), smoothstep(0.0, 0.12, fr) * smoothstep(1.0, 0.86, fr));
    a = smoothstep(1.0, 0.85, vRad);
  } else { // witch / onryo: long black hair with sheen
    col = vec3(0.018, 0.016, 0.02) + vec3(0.14, 0.13, 0.15) * pow(s2, 6.0) + vec3(0.05) * pow(s1, 4.0);
    a = smoothstep(tips, tips - 0.2, vRad);
  }
  a *= smoothstep(0.0, 0.18, vRad) * uIntensity; // soft hairline over the paint
  col *= mix(1.0, sh, 0.7);
  o = vec4(col * a, a);
}
`;

/** Rigid props: horns, witch hat, ears, clown nose, neck bolts, hair curtains. */
export const ACC_VS = /* glsl */ `${HEADER}
in vec2 aPos;
in vec2 aLocal;
out vec2 vLocal;
out vec2 vScreen;
void main() {
  vLocal = aLocal;
  vScreen = aPos;
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const ACC_FS = /* glsl */ `${HEADER}
${COMMON}
${LIGHTING}
in vec2 vLocal;
in vec2 vScreen;
uniform int uKind;
uniform vec3 uColor;
uniform float uTime, uIntensity;
out vec4 o;
void main() {
  float sh = clamp(luma(texture(uCam, vScreen).rgb) / skinRef(), 0.35, 1.3);
  float t = vLocal.x, s = vLocal.y;
  vec3 col;
  float a;
  if (uKind == 0) { // horn: (t base..tip, s across)
    float round_ = sqrt(max(0.0, 1.0 - s * s));
    float rings = 0.75 + 0.25 * smoothstep(0.2, 0.8, abs(fract(t * 11.0) - 0.5) * 2.0) * (1.0 - t);
    col = mix(vec3(0.16, 0.05, 0.03), vec3(0.05, 0.03, 0.03), t) * (0.35 + 0.9 * round_) * rings;
    col += vec3(0.9, 0.75, 0.6) * pow(max(0.0, 1.0 - abs(s + 0.4) * 2.2), 6.0) * 0.35;
    col += vec3(1.0, 0.35, 0.05) * (1.0 - smoothstep(0.0, 0.25, t)) * (0.4 + 0.3 * sin(uTime * 2.6));
    a = smoothstep(1.0, 0.85, abs(s));
  } else if (uKind == 1) { // hat cone
    float round_ = sqrt(max(0.0, 1.0 - s * s));
    col = uColor * (0.35 + 0.9 * round_) * (0.85 + 0.15 * noise(vec2(s * 5.0, t * 4.0)));
    col += vec3(0.25) * pow(max(0.0, 1.0 - abs(s + 0.45) * 2.5), 8.0) * 0.4;
    float band = step(0.03, t) * step(t, 0.13);
    col = mix(col, vec3(0.32, 0.08, 0.42) * (0.4 + 0.7 * round_), band);
    float buckle = band * step(abs(s), 0.18) * (1.0 - step(abs(s), 0.1) * step(0.055, t) * step(t, 0.105));
    col = mix(col, vec3(0.85, 0.7, 0.3) * (0.5 + 0.6 * round_), buckle);
    a = smoothstep(1.0, 0.9, abs(s));
  } else if (uKind == 2) { // flat disk (hat brim): local = unit disk
    float r = length(vLocal);
    col = uColor * (0.55 + 0.45 * smoothstep(1.0, 0.2, r)) * (0.9 + 0.1 * noise(vLocal * 20.0));
    a = smoothstep(1.0, 0.95, r);
  } else if (uKind == 3) { // sphere: local = unit disk
    float r = length(vLocal);
    vec3 n = vec3(vLocal, sqrt(max(0.0, 1.0 - r * r)));
    vec3 L = normalize(vec3(-0.4, -0.6, 0.7));
    float diff = max(dot(n, L), 0.0);
    float sp = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 28.0);
    col = uColor * (0.2 + 0.85 * diff) + vec3(sp * 0.7);
    a = smoothstep(1.0, 0.92, r);
  } else if (uKind == 4) { // furry ear
    float fur = noise(vec2(s * 30.0, t * 8.0)) * 0.6 + noise(vec2(s * 80.0, t * 16.0)) * 0.4;
    col = mix(vec3(0.16, 0.11, 0.07), vec3(0.5, 0.42, 0.32), fur);
    float inner = step(abs(s), 0.55 * (1.0 - t)) * step(t, 0.8);
    col = mix(col, vec3(0.35, 0.18, 0.16) * (0.6 + 0.4 * fur), inner * 0.8);
    a = smoothstep(1.0, 0.7 + 0.25 * fur, abs(s));
  } else { // kind 5: hair curtain — t down the length, s across (+1 = inner edge)
    float wave = sin(t * 6.0 + uTime * 0.6) * 0.04;
    float u = (s + 1.0) * 0.5 + wave;
    float strands = noise(vec2(u * 90.0, t * 3.0)) * 0.5 + noise(vec2(u * 240.0, t * 2.0)) * 0.5;
    col = vec3(0.015, 0.014, 0.018) + vec3(0.16, 0.15, 0.17) * pow(strands, 7.0);
    float edge = 0.78 + 0.18 * noise(vec2(t * 12.0, 1.0));
    a = smoothstep(edge, edge - 0.18, u) * smoothstep(1.0, 0.7 + 0.25 * noise(vec2(u * 25.0, 2.0)), t) * smoothstep(0.0, 0.18 + 0.1 * noise(vec2(u * 30.0, 5.0)), t);
    a *= 0.75 + 0.25 * strands;
  }
  col *= mix(1.0, sh, 0.6);
  a *= uIntensity;
  o = vec4(col * a, a);
}
`;
