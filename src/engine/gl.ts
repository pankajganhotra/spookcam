export type GL = WebGL2RenderingContext;

export interface Program {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation>;
}

function compile(gl: GL, type: number, src: string, label: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`[SpookCam] ${label} shader compile failed:\n${log}`);
  }
  return sh;
}

export function createProgram(gl: GL, vs: string, fs: string, label: string): Program {
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vs, `${label}.vs`));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fs, `${label}.fs`));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`[SpookCam] ${label} link failed:\n${gl.getProgramInfoLog(program)}`);
  }
  const uniforms = new Map<string, WebGLUniformLocation>();
  const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(program, i)!;
    const name = info.name.replace(/\[0\]$/, '');
    uniforms.set(name, gl.getUniformLocation(program, info.name)!);
  }
  return { program, uniforms };
}

type UniformValue = number | boolean | readonly number[] | Float32Array | { tex: WebGLTexture; unit: number };

/** Binds a program and sets uniforms by inferred type; silently skips optimized-out names. */
export function use(gl: GL, p: Program, values: Record<string, UniformValue>) {
  gl.useProgram(p.program);
  for (const [name, v] of Object.entries(values)) {
    const loc = p.uniforms.get(name);
    if (!loc) continue;
    if (typeof v === 'number') gl.uniform1f(loc, v);
    else if (typeof v === 'boolean') gl.uniform1i(loc, v ? 1 : 0);
    else if ('tex' in v) {
      gl.activeTexture(gl.TEXTURE0 + v.unit);
      gl.bindTexture(gl.TEXTURE_2D, v.tex);
      gl.uniform1i(loc, v.unit);
    } else if (v.length === 2) gl.uniform2fv(loc, v as Float32Array);
    else if (v.length === 3) gl.uniform3fv(loc, v as Float32Array);
    else if (v.length === 4) gl.uniform4fv(loc, v as Float32Array);
    else gl.uniform2fv(loc, v as Float32Array);
  }
}

export interface Target {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  width: number;
  height: number;
}

export function createTexture(gl: GL, filter: number = gl.LINEAR): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

export function createTarget(gl: GL, width: number, height: number, mipmapped = false): Target {
  const tex = createTexture(gl, mipmapped ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  if (mipmapped) gl.generateMipmap(gl.TEXTURE_2D);
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  return { fb, tex, width, height };
}

export function deleteTarget(gl: GL, t: Target | undefined) {
  if (!t) return;
  gl.deleteFramebuffer(t.fb);
  gl.deleteTexture(t.tex);
}

export function bindTarget(gl: GL, t: Target | null, width?: number, height?: number) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
  gl.viewport(0, 0, t ? t.width : width!, t ? t.height : height!);
}

/** One-Euro filter (Casiez et al.) — kills landmark jitter without adding lag on fast motion. */
export class OneEuro {
  private x?: Float32Array;
  private dx?: Float32Array;
  private t = 0;

  constructor(
    private minCutoff = 1.4,
    private beta = 0.02,
    private dCutoff = 1.0,
  ) {}

  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  reset() {
    this.x = undefined;
  }

  /** `scale` converts value units into the units `beta` is tuned for (pixels). */
  filter(v: Float32Array, tSec: number, scale = 1): Float32Array {
    if (!this.x || this.x.length !== v.length) {
      this.x = v.slice();
      this.dx = new Float32Array(v.length);
      this.t = tSec;
      return this.x;
    }
    const dt = Math.max(1e-3, tSec - this.t);
    this.t = tSec;
    const ad = OneEuro.alpha(this.dCutoff, dt);
    const x = this.x, dx = this.dx!;
    for (let i = 0; i < v.length; i++) {
      const d = (v[i] - x[i]) / dt;
      dx[i] += ad * (d - dx[i]);
      const cutoff = this.minCutoff + this.beta * Math.abs(dx[i]) * scale;
      x[i] += OneEuro.alpha(cutoff, dt) * (v[i] - x[i]);
    }
    return x;
  }
}
