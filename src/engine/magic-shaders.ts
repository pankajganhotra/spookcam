import { COMMON, HEADER } from './shaders';

/** CPU-simulated fire / smoke / spark particles. */
export const SPRITE_VS = /* glsl */ `${HEADER}
in vec2 aPos;
in float aSize;
in vec4 aColor;
out vec4 vColor;
out float vSeed;
void main() {
  vColor = aColor;
  vSeed = fract(aPos.x * 91.7 + aPos.y * 37.3);
  gl_PointSize = aSize;
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const SPRITE_FS = /* glsl */ `${HEADER}
${COMMON}
in vec4 vColor;
in float vSeed;
uniform float uSmoke;
out vec4 o;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float d = length(p);
  float body = smoothstep(0.5, 0.0, d);
  // Billowy, uneven puffs instead of perfect discs.
  float n = noise(p * (uSmoke > 0.5 ? 5.0 : 3.0) + vSeed * 40.0);
  float a = uSmoke > 0.5 ? body * (0.55 + 0.45 * n) : pow(body, 1.6) * (0.7 + 0.5 * n);
  o = vColor * a;
}
`;

/** Upright quad: aLocal = (x −1..1, y 0 bottom..1 top). */
export const FLAME_VS = /* glsl */ `${HEADER}
in vec2 aPos;
in vec2 aLocal;
out vec2 vLocal;
void main() {
  vLocal = aLocal;
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const FLAME_FS = /* glsl */ `${HEADER}
${COMMON}
in vec2 vLocal;
uniform int uKind;
uniform float uTime, uSeed;
out vec4 o;

vec3 ramp(float h) {
  // Cold edge → hot core.
  return mix(mix(vec3(0.5, 0.04, 0.0), vec3(1.0, 0.45, 0.05), smoothstep(0.0, 0.45, h)), vec3(1.0, 0.95, 0.75), smoothstep(0.55, 1.0, h));
}

void main() {
  vec2 p = vLocal;
  float t = uTime * 1.0 + uSeed;
  float heat;
  if (uKind == 0) {
    // Candle flame: a flickering teardrop above the wick with a blue base.
    float y = p.y;
    float sway = 0.12 * sin(t * 5.3) * y * y + 0.05 * (noise(vec2(t * 6.0, y * 3.0)) - 0.5) * y;
    float x = p.x - sway;
    float width = 0.55 * pow(max(0.0, 1.0 - y), 0.65) * smoothstep(0.0, 0.25, y + 0.02);
    float shape = 1.0 - smoothstep(width * 0.6, width, abs(x));
    float tip = 1.0 - smoothstep(0.75 + 0.1 * noise(vec2(t * 8.0, 2.0)), 1.0, y);
    heat = shape * tip * (1.0 - 0.35 * y);
    vec3 col = ramp(heat * 1.1);
    col = mix(col, vec3(0.25, 0.35, 1.0), smoothstep(0.25, 0.0, y) * shape * 0.7); // blue root
    float glow = exp(-length(vec2(p.x * 1.2, (p.y - 0.35) * 0.9)) * 3.0) * 0.35;
    float a = clamp(heat * 1.3 + glow, 0.0, 1.0);
    o = vec4(col * a + vec3(1.0, 0.5, 0.15) * glow * 0.6, a);
  } else {
    // Fireball: turbulent orb whose surface boils and licks upward.
    vec2 q = vec2(p.x, p.y * 2.0 - 1.0);
    float r = length(q);
    float ang = atan(q.y, q.x);
    float turb = fbm(vec2(ang * 2.0, r * 3.0 - t * 2.5)) + 0.5 * fbm(q * 3.0 + vec2(0.0, t * 1.8));
    float edge = 0.62 + 0.25 * (turb - 0.6) + 0.15 * max(0.0, -q.y) * noise(vec2(q.x * 6.0, t * 4.0));
    heat = smoothstep(edge, edge * 0.2, r);
    vec3 col = ramp(heat + 0.2 * turb);
    float glow = exp(-r * 2.4) * 0.6;
    float a = clamp(heat * 1.2 + glow * 0.5, 0.0, 1.0);
    o = vec4(col * a + vec3(1.0, 0.45, 0.1) * glow * 0.5, a);
  }
}
`;

/** Multiplies the scene by warm light from each flame: dst * (1 + light). */
export const LIGHT_FS = /* glsl */ `${HEADER}
in vec2 vUv;
uniform vec4 uLights[4]; // x, y (uv), radius (px), intensity
uniform int uCount;
uniform vec2 uRes;
out vec4 o;
void main() {
  vec3 light = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    if (i >= uCount) break;
    vec4 L = uLights[i];
    float d = length((vUv - L.xy) * uRes) / max(L.z, 1.0);
    light += vec3(1.0, 0.55, 0.22) * L.w * exp(-d * d * 2.2);
  }
  o = vec4(light * 1.4, 1.0);
}
`;
