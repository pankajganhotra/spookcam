import type { Settings } from '../shared/settings';
import type { SegmentationMask } from './detectors';
import { FACE_FEATHER, FACE_OVAL, FACE_SKIRT, FACE_TOTAL_VERTICES, FACE_TRIANGLES, FACE_UVS, FACE_VERTEX_COUNT, LEFT_EYE, LEFT_IRIS, MOUTH_INNER, RIGHT_EYE, RIGHT_IRIS } from './facemesh-data';
import { bindTarget, createProgram, createTarget, createTexture, deleteTarget, use, type GL, type Program, type Target } from './gl';
import * as S from './shaders';

const FILTER_IDS: Record<Settings['face'], number> = { none: 0, skull: 1, zombie: 2, demon: 3, vampire: 4, possessed: 5, wraith: 6, pumpkin: 7 };
const BACKDROP_IDS: Record<Settings['backdrop'], number> = { none: 0, graveyard: 1, bloodmoon: 2, void: 3 };
const TINT_IDS: Record<Settings['tint'], number> = { none: 0, blood: 1, sickly: 2, noir: 3, nightvision: 4 };
const STYLE_IDS: Record<Settings['vanishStyle'], number> = { dust: 0, embers: 1, cloak: 2 };
const WIND: Record<Settings['wind'], [number, number]> = { right: [0.94, -0.34], left: [-0.94, -0.34], up: [0.15, -0.99] };

const HORN_SEGMENTS = 20;

export interface VanishState {
  /** Seconds into the vanish timeline (0 = fully present). */
  t: number;
  duration: number;
  life: number;
  /** Particles colored from the live frame (reassembling) instead of the snapshot. */
  live: boolean;
}

export interface RenderInput {
  settings: Settings;
  /** Per face: 478 landmarks as interleaved normalized x,y. */
  faces: Float32Array[];
  vanish: VanishState;
  time: number;
  /** Freeze this frame's person layer as the particle color source. */
  snapshot?: boolean;
}

export class Renderer {
  readonly canvas: OffscreenCanvas;
  private gl: GL;
  private lost = false;
  private width = 0;
  private height = 0;

  private p!: Record<'copy' | 'mask' | 'plate' | 'coverage' | 'face' | 'eye' | 'mouth' | 'horn' | 'composite' | 'particle' | 'post', Program>;
  private camTex!: WebGLTexture;
  private rawMaskTex!: WebGLTexture;
  private maskSize = [0, 0];
  private mask: [Target?, Target?] = [];
  private plate: [Target?, Target?] = [];
  private person?: Target;
  private comp?: Target;
  private snapPerson?: Target;
  private snapMask?: Target;
  private faceVao!: WebGLVertexArrayObject;
  private facePosBuf!: WebGLBuffer;
  private featVao!: WebGLVertexArrayObject;
  private featBuf!: WebGLBuffer;
  private hornVao!: WebGLVertexArrayObject;
  private hornBuf!: WebGLBuffer;
  private emptyVao!: WebGLVertexArrayObject;
  private coverageTarget!: Target;
  private coveragePx = new Uint8Array(64 * 48 * 4);

  hasMask = false;
  private hasPlate = false;
  private frameNo = 0;
  coverage = 0;

  constructor() {
    this.canvas = new OffscreenCanvas(2, 2);
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      this.init();
      const [w, h] = [this.width, this.height];
      this.width = this.height = 0;
      if (w) this.resize(w, h);
    });
    this.init();
  }

  get ready() {
    return !this.lost;
  }

  private init() {
    const gl = this.gl;
    const q = S.QUAD_VS;
    this.p = {
      copy: createProgram(gl, q, S.COPY_FS, 'copy'),
      mask: createProgram(gl, q, S.MASK_FS, 'mask'),
      plate: createProgram(gl, q, S.PLATE_FS, 'plate'),
      coverage: createProgram(gl, q, S.COVERAGE_FS, 'coverage'),
      face: createProgram(gl, S.FACE_VS, S.FACE_FS, 'face'),
      eye: createProgram(gl, S.FEATURE_VS, S.EYE_FS, 'eye'),
      mouth: createProgram(gl, S.FEATURE_VS, S.MOUTH_FS, 'mouth'),
      horn: createProgram(gl, S.HORN_VS, S.HORN_FS, 'horn'),
      composite: createProgram(gl, q, S.COMPOSITE_FS, 'composite'),
      particle: createProgram(gl, S.PARTICLE_VS, S.PARTICLE_FS, 'particle'),
      post: createProgram(gl, q, S.POST_FS, 'post'),
    };
    this.camTex = createTexture(gl);
    this.rawMaskTex = createTexture(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(1));
    this.maskSize = [0, 0];
    this.mask = [];
    this.hasMask = false;
    this.hasPlate = false;

    // Face mesh: static UV + feather, dynamic positions.
    this.faceVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.faceVao);
    const attr = (prog: Program, name: string) => gl.getAttribLocation(prog.program, name);
    this.facePosBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.facePosBuf);
    gl.bufferData(gl.ARRAY_BUFFER, FACE_TOTAL_VERTICES * 8, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(attr(this.p.face, 'aPos'));
    gl.vertexAttribPointer(attr(this.p.face, 'aPos'), 2, gl.FLOAT, false, 0, 0);
    const uvBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, FACE_UVS, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(attr(this.p.face, 'aUv'));
    gl.vertexAttribPointer(attr(this.p.face, 'aUv'), 2, gl.FLOAT, false, 0, 0);
    const featherBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, featherBuf);
    gl.bufferData(gl.ARRAY_BUFFER, FACE_FEATHER, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(attr(this.p.face, 'aFeather'));
    gl.vertexAttribPointer(attr(this.p.face, 'aFeather'), 1, gl.FLOAT, false, 0, 0);
    const idx = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, FACE_TRIANGLES, gl.STATIC_DRAW);

    // Eye / mouth fans: interleaved x, y, edge. Eye & mouth programs share FEATURE_VS layout.
    this.featVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.featVao);
    this.featBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.featBuf);
    gl.bufferData(gl.ARRAY_BUFFER, 64 * 12, gl.DYNAMIC_DRAW);
    for (const prog of [this.p.eye, this.p.mouth]) {
      gl.enableVertexAttribArray(attr(prog, 'aPos'));
      gl.vertexAttribPointer(attr(prog, 'aPos'), 2, gl.FLOAT, false, 12, 0);
      gl.enableVertexAttribArray(attr(prog, 'aEdge'));
      gl.vertexAttribPointer(attr(prog, 'aEdge'), 1, gl.FLOAT, false, 12, 8);
    }

    this.hornVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.hornVao);
    this.hornBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.hornBuf);
    gl.bufferData(gl.ARRAY_BUFFER, (HORN_SEGMENTS + 1) * 2 * 16, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(attr(this.p.horn, 'aPos'));
    gl.vertexAttribPointer(attr(this.p.horn, 'aPos'), 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(attr(this.p.horn, 'aHorn'));
    gl.vertexAttribPointer(attr(this.p.horn, 'aHorn'), 2, gl.FLOAT, false, 16, 8);

    this.emptyVao = gl.createVertexArray()!;
    gl.bindVertexArray(null);
    this.coverageTarget = createTarget(gl, 64, 48);
  }

  resize(w: number, h: number) {
    if (w === this.width && h === this.height) return;
    const gl = this.gl;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    for (const t of [...this.plate, this.person, this.comp, this.snapPerson]) deleteTarget(gl, t);
    this.plate = [createTarget(gl, w, h, true), createTarget(gl, w, h, true)];
    this.person = createTarget(gl, w, h);
    this.comp = createTarget(gl, w, h);
    this.snapPerson = createTarget(gl, w, h);
    this.hasPlate = false;
    this.coverage = 0;
  }

  get size() {
    return [this.width, this.height] as const;
  }

  uploadFrame(frame: TexImageSource) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.camTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
  }

  private quad() {
    this.gl.bindVertexArray(this.emptyVao);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  /** Feeds a new segmentation result through temporal smoothing. */
  updateMask(m: SegmentationMask) {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D, this.rawMaskTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, m.width, m.height, 0, gl.RED, gl.UNSIGNED_BYTE, m.data);
    if (this.maskSize[0] !== m.width || this.maskSize[1] !== m.height) {
      for (const t of [...this.mask, this.snapMask]) deleteTarget(gl, t);
      this.mask = [createTarget(gl, m.width, m.height), createTarget(gl, m.width, m.height)];
      this.snapMask = createTarget(gl, m.width, m.height);
      this.maskSize = [m.width, m.height];
      this.hasMask = false;
    }
    const [prev, next] = this.mask as [Target, Target];
    bindTarget(gl, next);
    use(gl, this.p.mask, {
      uRaw: { tex: this.rawMaskTex, unit: 0 },
      uPrev: { tex: prev.tex, unit: 1 },
      uTexel: [1 / m.width, 1 / m.height],
      uBlend: this.hasMask ? 0.6 : 1,
    });
    this.quad();
    this.mask = [next, prev];
    this.hasMask = true;
  }

  /** Accumulates background pixels (where nobody stands) into the clean plate. */
  learnPlate() {
    if (!this.hasMask) return;
    const gl = this.gl;
    gl.disable(gl.BLEND);
    const [prev, next] = this.plate as [Target, Target];
    bindTarget(gl, next);
    use(gl, this.p.plate, {
      uPlate: { tex: prev.tex, unit: 0 },
      uCam: { tex: this.camTex, unit: 1 },
      uMask: { tex: this.mask[0]!.tex, unit: 2 },
      uMaskTexel: [1 / this.maskSize[0], 1 / this.maskSize[1]],
    });
    this.quad();
    gl.bindTexture(gl.TEXTURE_2D, next.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.plate = [next, prev];
    this.hasPlate = true;
    if (++this.frameNo % 20 === 1) this.readCoverage();
  }

  /** Share of the area currently covered by people whose background has already been seen. */
  private readCoverage() {
    const gl = this.gl;
    bindTarget(gl, this.coverageTarget);
    use(gl, this.p.coverage, { uMask: { tex: this.mask[0]!.tex, unit: 0 }, uPlate: { tex: this.plate[0]!.tex, unit: 1 } });
    this.quad();
    const px = this.coveragePx;
    gl.readPixels(0, 0, 64, 48, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let known = 0, person = 0;
    for (let i = 0; i < px.length; i += 4) {
      known += px[i];
      person += px[i + 1];
    }
    this.coverage = person < 255 * 4 ? 1 : known / person;
  }

  resetPlate() {
    const gl = this.gl;
    for (const t of this.plate) {
      if (!t) continue;
      bindTarget(gl, t);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    this.coverage = 0;
  }

  /** Freezes the current person + mask so the dust keeps its colors while the body dissolves. */
  snapshot() {
    if (!this.hasMask || !this.person) return;
    const gl = this.gl;
    gl.disable(gl.BLEND);
    bindTarget(gl, this.snapPerson!);
    use(gl, this.p.copy, { uTex: { tex: this.person.tex, unit: 0 } });
    this.quad();
    bindTarget(gl, this.snapMask!);
    use(gl, this.p.copy, { uTex: { tex: this.mask[0]!.tex, unit: 0 } });
    this.quad();
  }

  render(input: RenderInput) {
    const gl = this.gl;
    const { settings: s, vanish } = input;
    const [w, h] = [this.width, this.height];
    const res: [number, number] = [w, h];
    const filter = FILTER_IDS[s.face];

    // 1. Person layer = camera + face paint.
    gl.disable(gl.BLEND);
    bindTarget(gl, this.person!);
    use(gl, this.p.copy, { uTex: { tex: this.camTex, unit: 0 } });
    this.quad();
    if (filter && input.faces.length) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      for (let i = 0; i < input.faces.length; i++) this.drawFace(input.faces[i], filter, s.faceIntensity, input.time, res, i);
    }
    if (input.snapshot) this.snapshot();

    // 2. Composite person over backdrop / learned plate, apply the vanish front.
    const vanishing = vanish.t > 0;
    const needFill = (vanishing || s.ghost) && s.backdrop === 'none';
    gl.disable(gl.BLEND);
    bindTarget(gl, this.comp!);
    const wind = WIND[s.wind];
    const style = STYLE_IDS[s.vanishStyle];
    const plateTex = this.plate[0]!.tex;
    use(gl, this.p.composite, {
      uPerson: { tex: this.person!.tex, unit: 0 },
      uMask: { tex: (this.mask[0] ?? this.person!).tex, unit: 1 },
      uPlate: { tex: plateTex, unit: 2 },
      uHasMask: this.hasMask,
      uNeedFill: needFill && this.hasPlate,
      uGhost: s.ghost,
      uT: vanish.t,
      uDur: vanish.duration,
      uTime: input.time,
      uPlateLods: Math.floor(Math.log2(Math.max(w, h))),
      uMaskTexel: [1 / Math.max(1, this.maskSize[0]), 1 / Math.max(1, this.maskSize[1])],
      uWind: wind,
      uAspect: w / h,
    });
    gl.uniform1i(this.p.composite.uniforms.get('uBackdrop')!, BACKDROP_IDS[s.backdrop]);
    gl.uniform1i(this.p.composite.uniforms.get('uStyle')!, style);
    this.quad();

    // 3. Dust / embers.
    if (vanishing && style !== 2 && this.hasMask && vanish.t < vanish.duration + vanish.life) {
      const cell = Math.max(2, Math.round(w / 300));
      const grid: [number, number] = [Math.ceil(w / cell), Math.ceil(h / cell)];
      gl.enable(gl.BLEND);
      if (style === 1) gl.blendFunc(gl.ONE, gl.ONE);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      use(gl, this.p.particle, {
        uSrc: { tex: (vanish.live ? this.person! : this.snapPerson!).tex, unit: 0 },
        uSrcMask: { tex: (vanish.live ? this.mask[0]! : this.snapMask!).tex, unit: 1 },
        uGrid: grid,
        uT: vanish.t,
        uDur: vanish.duration,
        uLife: vanish.life,
        uPointPx: cell * 1.7,
        uWind: wind,
        uAspect: w / h,
      });
      gl.uniform1i(this.p.particle.uniforms.get('uStyle')!, style);
      gl.bindVertexArray(this.emptyVao);
      gl.drawArrays(gl.POINTS, 0, grid[0] * grid[1]);
      gl.disable(gl.BLEND);
    }

    // 4. Atmosphere grade straight to the canvas.
    bindTarget(gl, null, w, h);
    use(gl, this.p.post, {
      uTex: { tex: this.comp!.tex, unit: 0 },
      uTime: input.time,
      uVignette: s.vignette,
      uGrain: s.grain,
      uFlicker: s.flicker,
      uGlitch: s.glitch,
      uFog: s.fog,
      uAspect: w / h,
      uRes: res,
    });
    gl.uniform1i(this.p.post.uniforms.get('uTint')!, TINT_IDS[s.tint]);
    this.quad();
  }

  private drawFace(lm: Float32Array, filter: number, intensity: number, time: number, res: [number, number], faceIndex: number) {
    const gl = this.gl;
    const seed = faceIndex * 13.7;

    gl.bindVertexArray(this.faceVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.facePosBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.meshPositions(lm));
    use(gl, this.p.face, { uCam: { tex: this.camTex, unit: 0 }, uTime: time, uIntensity: intensity, uSeed: seed });
    gl.uniform1i(this.p.face.uniforms.get('uFilter')!, filter);
    gl.drawElements(gl.TRIANGLES, FACE_TRIANGLES.length, gl.UNSIGNED_SHORT, 0);

    // Eyes.
    const P = (i: number) => [lm[i * 2], lm[i * 2 + 1]] as const;
    const px = (i: number) => [lm[i * 2] * res[0], lm[i * 2 + 1] * res[1]] as const;
    const dist = (a: number, b: number) => Math.hypot(px(a)[0] - px(b)[0], px(a)[1] - px(b)[1]);
    const hasIris = lm.length >= 478 * 2;
    for (const [contour, iris] of [[RIGHT_EYE, RIGHT_IRIS], [LEFT_EYE, LEFT_IRIS]] as const) {
      const n = this.fillFan(contour, lm);
      const center = hasIris ? P(iris) : this.centroid(contour, lm);
      const irisR = hasIris ? (dist(iris + 1, iris + 3) + dist(iris + 2, iris + 4)) / 4 : dist(contour[0], contour[8]) * 0.22;
      use(gl, this.p.eye, {
        uCam: { tex: this.camTex, unit: 0 },
        uIris: center as unknown as number[],
        uIrisR: irisR,
        uRes: res,
        uTime: time,
        uIntensity: intensity,
      });
      gl.uniform1i(this.p.eye.uniforms.get('uFilter')!, filter);
      gl.bindVertexArray(this.featVao);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, n);
    }

    // Inner mouth (only matters once the lips part).
    if (dist(13, 14) > 1.5) {
      const n = this.fillFan(MOUTH_INNER, lm);
      use(gl, this.p.mouth, {
        uCam: { tex: this.camTex, unit: 0 },
        uRes: res,
        uMouthL: P(78) as unknown as number[],
        uMouthR: P(308) as unknown as number[],
        uMouthTop: P(13) as unknown as number[],
        uMouthBot: P(14) as unknown as number[],
        uTime: time,
        uIntensity: intensity,
      });
      gl.uniform1i(this.p.mouth.uniforms.get('uFilter')!, filter);
      gl.bindVertexArray(this.featVao);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, n);
    }

    if (filter === FILTER_IDS.demon) this.drawHorns(lm, res, time, intensity);
  }

  private meshPos = new Float32Array(FACE_TOTAL_VERTICES * 2);

  /** Landmarks followed by the skirt ring pushed outward from the face oval's center. */
  private meshPositions(lm: Float32Array) {
    const out = this.meshPos;
    out.set(lm.subarray(0, FACE_VERTEX_COUNT * 2));
    const [cx, cy] = this.centroid(FACE_OVAL, lm);
    for (let k = 0; k < FACE_OVAL.length; k++) {
      const i = FACE_OVAL[k], e = FACE_SKIRT[k];
      out[(FACE_VERTEX_COUNT + k) * 2] = lm[i * 2] + (lm[i * 2] - cx) * e;
      out[(FACE_VERTEX_COUNT + k) * 2 + 1] = lm[i * 2 + 1] + (lm[i * 2 + 1] - cy) * e;
    }
    return out;
  }

  private centroid(contour: readonly number[], lm: Float32Array): [number, number] {
    let x = 0, y = 0;
    for (const i of contour) {
      x += lm[i * 2];
      y += lm[i * 2 + 1];
    }
    return [x / contour.length, y / contour.length];
  }

  private fan = new Float32Array(64 * 3);

  /** Writes center + rim (+ closing vertex) into the feature buffer; returns the vertex count. */
  private fillFan(contour: readonly number[], lm: Float32Array): number {
    const [cx, cy] = this.centroid(contour, lm);
    const f = this.fan;
    f[0] = cx; f[1] = cy; f[2] = 1;
    let k = 3;
    for (let j = 0; j <= contour.length; j++) {
      const i = contour[j % contour.length];
      f[k++] = lm[i * 2];
      f[k++] = lm[i * 2 + 1];
      f[k++] = 0;
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.featBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, f, 0, k);
    return k / 3;
  }

  private hornData = new Float32Array((HORN_SEGMENTS + 1) * 2 * 4);

  private drawHorns(lm: Float32Array, res: [number, number], time: number, intensity: number) {
    const gl = this.gl;
    const [W, H] = res;
    const px = (i: number) => [lm[i * 2] * W, lm[i * 2 + 1] * H];
    const top = px(10), chin = px(152);
    let ux = top[0] - chin[0], uy = top[1] - chin[1];
    const faceH = Math.hypot(ux, uy);
    if (faceH < 20) return;
    ux /= faceH; uy /= faceH;
    // "right" in image space, perpendicular to up.
    const rx = -uy, ry = ux;
    const mid = px(168);
    use(gl, this.p.horn, { uTime: time, uIntensity: intensity });
    gl.bindVertexArray(this.hornVao);
    for (const anchor of [67, 297]) {
      const a = px(anchor);
      const out = Math.sign((a[0] - mid[0]) * rx + (a[1] - mid[1]) * ry) || (anchor === 67 ? -1 : 1);
      const bx = a[0] + ux * faceH * 0.02, by = a[1] + uy * faceH * 0.02;
      const d = this.hornData;
      let k = 0;
      for (let i = 0; i <= HORN_SEGMENTS; i++) {
        const t = i / HORN_SEGMENTS;
        // Rise up and outward, then hook back inward at the tip.
        const o = (0.16 * t + 0.1 * Math.sin(t * Math.PI * 0.9) - 0.12 * t * t * t) * faceH * out;
        const u = (0.42 * t - 0.06 * t * t) * faceH;
        const cx = bx + rx * o + ux * u, cy = by + ry * o + uy * u;
        // Tangent for the strip normal.
        const t2 = Math.min(1, t + 0.01);
        const o2 = (0.16 * t2 + 0.1 * Math.sin(t2 * Math.PI * 0.9) - 0.12 * t2 * t2 * t2) * faceH * out;
        const u2 = (0.42 * t2 - 0.06 * t2 * t2) * faceH;
        let tx = bx + rx * o2 + ux * u2 - cx, ty = by + ry * o2 + uy * u2 - cy;
        const tl = Math.hypot(tx, ty) || 1;
        tx /= tl; ty /= tl;
        const halfW = 0.065 * faceH * Math.pow(1 - t, 0.85) + 0.5;
        for (const s of [-1, 1]) {
          d[k++] = (cx - ty * halfW * s) / W;
          d[k++] = (cy + tx * halfW * s) / H;
          d[k++] = t;
          d[k++] = s;
        }
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.hornBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, d);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, (HORN_SEGMENTS + 1) * 2);
    }
  }

  dispose() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
