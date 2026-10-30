import type { Settings } from '../shared/settings';
import type { SegmentationMask } from './detectors';
import { FACE_FEATHER, FACE_OVAL, FACE_SKIRT, FACE_TOTAL_VERTICES, FACE_TRIANGLES, FACE_UVS, FACE_VERTEX_COUNT, LEFT_EYE, LEFT_IRIS, MOUTH_INNER, RIGHT_EYE, RIGHT_IRIS } from './facemesh-data';
import { bindTarget, createProgram, createTarget, createTexture, deleteTarget, use, type GL, type Program, type Target } from './gl';
import * as S from './shaders';
import * as F from './face-shaders';
import { FILTERS } from './face-shaders';
import { buildHalo, faceFrame, PROP, propsFor, type Prop } from './characters';
import * as M from './magic-shaders';
import type { HallucinationState } from './hallucinations';
import type { MagicFrame } from './magic';

const FILTER_IDS: Record<Settings['face'], number> = { none: 0, ...FILTERS };
const BACKDROP_IDS: Record<Settings['backdrop'], number> = { none: 0, graveyard: 1, bloodmoon: 2, void: 3 };
const TINT_IDS: Record<Settings['tint'], number> = { none: 0, blood: 1, sickly: 2, noir: 3, nightvision: 4, sepia: 5 };
const STYLE_IDS: Record<Settings['vanishStyle'], number> = { dust: 0, embers: 1, cloak: 2 };
const WIND: Record<Settings['wind'], [number, number]> = { right: [0.94, -0.34], left: [-0.94, -0.34], up: [0.15, -0.99] };

/** Landmarks sampled to measure how bright skin currently is: cheeks, forehead, nose bridge, chin. */
const SKIN_POINTS = [50, 280, 151, 6, 199];

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
  hall?: HallucinationState;
  magic?: MagicFrame;
  /** Talon strips (x, y uv, t, s) to draw on the person layer. */
  claws?: Float32Array[];
}

export class Renderer {
  readonly canvas: OffscreenCanvas;
  private gl: GL;
  private lost = false;
  private width = 0;
  private height = 0;

  private p!: Record<'copy' | 'mask' | 'plate' | 'coverage' | 'face' | 'eye' | 'mouth' | 'halo' | 'acc' | 'echo' | 'sprite' | 'flame' | 'light' | 'composite' | 'particle' | 'post', Program>;
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
  private accVao!: WebGLVertexArrayObject;
  private accBuf!: WebGLBuffer;
  private haloVao!: WebGLVertexArrayObject;
  private haloBuf!: WebGLBuffer;
  private haloData = new Float32Array(80 * 5);
  private spriteVao!: WebGLVertexArrayObject;
  private spriteBuf!: WebGLBuffer;
  private flameVao!: WebGLVertexArrayObject;
  private flameBuf!: WebGLBuffer;
  private echo?: Target;
  private echoFrame = 0;
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
      face: createProgram(gl, F.FACE_VS, F.FACE_FS, 'face'),
      eye: createProgram(gl, F.FEATURE_VS, F.EYE_FS, 'eye'),
      mouth: createProgram(gl, F.FEATURE_VS, F.MOUTH_FS, 'mouth'),
      halo: createProgram(gl, F.HALO_VS, F.HALO_FS, 'halo'),
      acc: createProgram(gl, F.ACC_VS, F.ACC_FS, 'acc'),
      echo: createProgram(gl, q, S.ECHO_FS, 'echo'),
      sprite: createProgram(gl, M.SPRITE_VS, M.SPRITE_FS, 'sprite'),
      flame: createProgram(gl, M.FLAME_VS, M.FLAME_FS, 'flame'),
      light: createProgram(gl, q, M.LIGHT_FS, 'light'),
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

    this.accVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.accVao);
    this.accBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.accBuf);
    gl.bufferData(gl.ARRAY_BUFFER, 256 * 16, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(attr(this.p.acc, 'aPos'));
    gl.vertexAttribPointer(attr(this.p.acc, 'aPos'), 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(attr(this.p.acc, 'aLocal'));
    gl.vertexAttribPointer(attr(this.p.acc, 'aLocal'), 2, gl.FLOAT, false, 16, 8);

    this.haloVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.haloVao);
    this.haloBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.haloBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.haloData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(attr(this.p.halo, 'aPos'));
    gl.vertexAttribPointer(attr(this.p.halo, 'aPos'), 2, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(attr(this.p.halo, 'aRad'));
    gl.vertexAttribPointer(attr(this.p.halo, 'aRad'), 1, gl.FLOAT, false, 20, 8);
    gl.enableVertexAttribArray(attr(this.p.halo, 'aDir'));
    gl.vertexAttribPointer(attr(this.p.halo, 'aDir'), 2, gl.FLOAT, false, 20, 12);

    this.spriteVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.spriteVao);
    this.spriteBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuf);
    gl.bufferData(gl.ARRAY_BUFFER, 1400 * 28, gl.DYNAMIC_DRAW);
    for (const [name, size, offset] of [['aPos', 2, 0], ['aSize', 1, 8], ['aColor', 4, 12]] as const) {
      gl.enableVertexAttribArray(attr(this.p.sprite, name));
      gl.vertexAttribPointer(attr(this.p.sprite, name), size, gl.FLOAT, false, 28, offset);
    }

    this.flameVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.flameVao);
    this.flameBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flameBuf);
    gl.bufferData(gl.ARRAY_BUFFER, 4 * 16, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(attr(this.p.flame, 'aPos'));
    gl.vertexAttribPointer(attr(this.p.flame, 'aPos'), 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(attr(this.p.flame, 'aLocal'));
    gl.vertexAttribPointer(attr(this.p.flame, 'aLocal'), 2, gl.FLOAT, false, 16, 8);

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
    for (const t of [...this.plate, this.person, this.comp, this.snapPerson, this.echo]) deleteTarget(gl, t);
    this.echo = createTarget(gl, w, h);
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
    const light = this.lightUniforms(input.faces[0], res, input.time);
    if (input.claws?.length) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.drawProps(input.claws.map((data) => ({ kind: PROP.claw, color: [0, 0, 0], mode: 'strip', data, count: data.length / 4, layer: 'front' })), 'front', light);
    }
    if (input.snapshot) this.snapshot();

    // Echo hallucination: refresh the afterimage every few frames so it lags and strobes.
    const hall = input.hall;
    if (hall && hall.echo > 0 && this.hasMask && this.echoFrame++ % 7 === 0) {
      gl.disable(gl.BLEND);
      bindTarget(gl, this.echo!);
      use(gl, this.p.echo, { uPerson: { tex: this.person!.tex, unit: 0 }, uMask: { tex: this.mask[0]!.tex, unit: 1 } });
      this.quad();
    }

    // 2. Composite person over backdrop / learned plate, apply the vanish front.
    const vanishing = vanish.t > 0;
    const needFill = (vanishing || s.ghost || !!hall?.active) && s.backdrop === 'none';
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
      ...this.hallucinationUniforms(hall, input.faces[0], res),
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

    if (input.magic) this.drawMagic(input.magic, res, input.time, light);

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
      uFlash: hall?.flash ?? 0,
    });
    gl.uniform1i(this.p.post.uniforms.get('uTint')!, TINT_IDS[s.tint]);
    this.quad();
  }

  /** Camera + skin-reference uniforms shared by the lit face/prop programs. */
  private lightUniforms(lm: Float32Array | undefined, res: [number, number], time: number) {
    const skin = new Float32Array(SKIN_POINTS.length * 2).fill(0.5);
    if (lm) SKIN_POINTS.forEach((i, k) => skin.set([lm[i * 2], lm[i * 2 + 1]], k * 2));
    return { uCam: { tex: this.camTex, unit: 0 }, uSkin: skin, uTexel: [1 / res[0], 1 / res[1]], uTime: time, uIntensity: 1 };
  }

  private hallucinationUniforms(hall: HallucinationState | undefined, lm: Float32Array | undefined, res: [number, number]) {
    const off = { uWarp: false, uJaw: 0, uBulge: 0, uMelt: 0, uEcho: 0, uJerk: [0, 0], uFigure: [0, 0, 1], uRes: res, uEchoTex: { tex: this.echo!.tex, unit: 3 } };
    if (!hall || (!hall.active && !hall.flash)) return off;
    const out = { ...off, uWarp: true, uJerk: hall.jerk, uEcho: hall.echo, uFigure: hall.figure };
    const f = lm && faceFrame(lm, res);
    if (!f || !lm) return out;
    const P = (i: number) => [lm[i * 2], lm[i * 2 + 1]];
    return {
      ...out,
      uJaw: hall.jaw,
      uBulge: hall.eyes,
      uMelt: hall.melt,
      uMouth: [(lm[26] + lm[28]) / 2, (lm[27] + lm[29]) / 2], // between landmarks 13 and 14
      uEyeL: P(468),
      uEyeR: P(473),
      uFaceC: P(1),
      uDown: [-f.up[0], -f.up[1]],
      uFaceS: f.faceH,
    };
  }

  private drawMagic(m: MagicFrame, res: [number, number], time: number, light: ReturnType<Renderer['lightUniforms']>) {
    const gl = this.gl;
    const [W, H] = res;
    gl.enable(gl.BLEND);
    // Flames light up the room: dst * (1 + light).
    if (m.lights.length) {
      gl.blendFunc(gl.DST_COLOR, gl.ONE);
      use(gl, this.p.light, { uRes: res });
      gl.uniform4fv(this.p.light.uniforms.get('uLights')!, Float32Array.from(m.lights.flatMap((l) => [l.x / W, l.y / H, l.radius, l.intensity])).slice(0, 16));
      gl.uniform1i(this.p.light.uniforms.get('uCount')!, m.lights.length);
      this.quad();
    }
    const sprites = (data: Float32Array, count: number, smoke: boolean) => {
      if (!count) return;
      gl.bindVertexArray(this.spriteVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * 7);
      use(gl, this.p.sprite, { uSmoke: smoke ? 1 : 0 });
      gl.drawArrays(gl.POINTS, 0, count);
    };
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    sprites(m.smoke, m.smokeCount, true);
    this.drawProps(m.candles.map((data) => ({ kind: PROP.candle, color: [0, 0, 0], mode: 'strip', data, count: 4, layer: 'front' })), 'front', light);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (const f of m.flames) {
      // Candle flames sit above their point; fireballs are centred on it.
      const hw = f.kind === 0 ? f.size * 0.45 : f.size;
      const y0 = f.kind === 0 ? f.y + f.size * 0.08 : f.y + f.size;
      const y1 = f.kind === 0 ? f.y - f.size * 1.3 : f.y - f.size;
      const quad = new Float32Array([
        (f.x - hw) / W, y0 / H, -1, 0,
        (f.x + hw) / W, y0 / H, 1, 0,
        (f.x - hw) / W, y1 / H, -1, 1,
        (f.x + hw) / W, y1 / H, 1, 1,
      ]);
      gl.bindVertexArray(this.flameVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.flameBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, quad);
      use(gl, this.p.flame, { uTime: time, uSeed: f.seed });
      gl.uniform1i(this.p.flame.uniforms.get('uKind')!, f.kind);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    sprites(m.fire, m.fireCount, false);
    gl.disable(gl.BLEND);
  }

  private drawFace(lm: Float32Array, filter: number, intensity: number, time: number, res: [number, number], faceIndex: number) {
    const gl = this.gl;
    const frame = faceFrame(lm, res);
    if (!frame) return;
    const skin = new Float32Array(SKIN_POINTS.length * 2);
    SKIN_POINTS.forEach((i, k) => skin.set([lm[i * 2], lm[i * 2 + 1]], k * 2));
    // Shared by every face program: camera texture + skin brightness reference.
    const light = { uCam: { tex: this.camTex, unit: 0 }, uSkin: skin, uTexel: [1 / res[0], 1 / res[1]], uTime: time, uIntensity: intensity };
    const props = propsFor(filter, frame);

    this.drawProps(props, 'back', light);

    gl.bindVertexArray(this.faceVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.facePosBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.meshPositions(lm));
    use(gl, this.p.face, { ...light, uSeed: faceIndex * 13.7 });
    gl.uniform1i(this.p.face.uniforms.get('uFilter')!, filter);
    gl.drawElements(gl.TRIANGLES, FACE_TRIANGLES.length, gl.UNSIGNED_SHORT, 0);

    // Hair, fur and wraps go over the paint's soft skirt so the hairline reads as real.
    const haloCount = buildHalo(filter, frame, this.haloData);
    if (haloCount) {
      gl.bindVertexArray(this.haloVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.haloBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.haloData, 0, haloCount * 5);
      use(gl, this.p.halo, light);
      gl.uniform1i(this.p.halo.uniforms.get('uFilter')!, filter);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, haloCount);
    }

    // Eyes.
    const P = (i: number) => [lm[i * 2], lm[i * 2 + 1]];
    const px = (i: number) => [lm[i * 2] * res[0], lm[i * 2 + 1] * res[1]] as const;
    const dist = (a: number, b: number) => Math.hypot(px(a)[0] - px(b)[0], px(a)[1] - px(b)[1]);
    const hasIris = lm.length >= 478 * 2;
    for (const [contour, iris] of [[RIGHT_EYE, RIGHT_IRIS], [LEFT_EYE, LEFT_IRIS]] as const) {
      const n = this.fillFan(contour, lm);
      const center = hasIris ? P(iris) : this.centroid(contour, lm);
      const irisR = hasIris ? (dist(iris + 1, iris + 3) + dist(iris + 2, iris + 4)) / 4 : dist(contour[0], contour[8]) * 0.22;
      use(gl, this.p.eye, { ...light, uIris: center, uIrisR: irisR, uRes: res });
      gl.uniform1i(this.p.eye.uniforms.get('uFilter')!, filter);
      gl.bindVertexArray(this.featVao);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, n);
    }

    // Inner mouth (only matters once the lips part).
    if (dist(13, 14) > 1.5) {
      const n = this.fillFan(MOUTH_INNER, lm);
      use(gl, this.p.mouth, { ...light, uRes: res, uMouthL: P(78), uMouthR: P(308), uMouthTop: P(13), uMouthBot: P(14) });
      gl.uniform1i(this.p.mouth.uniforms.get('uFilter')!, filter);
      gl.bindVertexArray(this.featVao);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, n);
    }

    this.drawProps(props, 'front', light);
  }

  private drawProps(props: Prop[], layer: Prop['layer'], light: Parameters<typeof use>[2]) {
    const gl = this.gl;
    for (const p of props) {
      if (p.layer !== layer) continue;
      gl.bindVertexArray(this.accVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.accBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, p.data);
      use(gl, this.p.acc, { ...light, uColor: p.color });
      gl.uniform1i(this.p.acc.uniforms.get('uKind')!, p.kind);
      gl.drawArrays(p.mode === 'fan' ? gl.TRIANGLE_FAN : gl.TRIANGLE_STRIP, 0, p.count);
    }
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

  dispose() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
