import { FaceLandmarker, HandLandmarker, ImageSegmenter } from '@mediapipe/tasks-vision';
// Generated at build time: MediaPipe's Emscripten loader wrapped in a private scope so it
// never touches (or gets clobbered by) a page's own `ModuleFactory` global.
import { ModuleFactory } from './vendor/mediapipe-loader.js';

type WasmFileset = Parameters<typeof FaceLandmarker.createFromOptions>[0];

export type AssetName = 'wasm' | 'face' | 'segmenter' | 'hand';
export type AssetLoader = (name: AssetName) => Promise<ArrayBuffer>;

export interface SegmentationMask {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface DetectRequest {
  face: boolean;
  mask: boolean;
  hands: boolean;
  maxFaces: number;
}

/** Blendshape scores kept per face, in this order. */
export const BLENDSHAPES = ['jawOpen', 'mouthPucker', 'mouthFunnel'] as const;

export interface DetectResult {
  /** Per face: 478 landmarks as interleaved normalized x,y. null = model not ready. */
  faces: Float32Array[] | null;
  /** Only set when a new mask is available since the last call. */
  mask: SegmentationMask | null;
  /** Per face, scores for BLENDSHAPES. */
  blend: Float32Array[] | null;
  /** Per hand: 21 landmarks as interleaved normalized x,y. null = model not ready. */
  hands: Float32Array[] | null;
}

export interface DetectorBackend {
  readonly loading: boolean;
  readonly error: string | undefined;
  /** Starts loading models ahead of use. */
  warm(want: { face: boolean; mask: boolean; hands?: boolean }): void;
  detect(frame: VideoFrame, want: DetectRequest): DetectResult;
  close(): void;
}

// The loader script is pre-bundled, so tasks-vision must not try to inject a <script>.
const FILESET: WasmFileset = { wasmLoaderPath: '', wasmBinaryPath: 'spookcam://vision.wasm' };
const MAX_FACES = 3;

type Global = typeof globalThis & { ModuleFactory?: unknown; Module?: unknown };

let globalsLock: Promise<unknown> = Promise.resolve();

/**
 * tasks-vision reads `self.ModuleFactory` / `self.Module` while creating a task and clears them
 * afterwards. Swap ours in for the duration and restore whatever the page had.
 */
function withWasmGlobals<T>(wasm: ArrayBuffer, create: () => Promise<T>): Promise<T> {
  const run = async () => {
    const g = globalThis as Global;
    const had = { factory: g.ModuleFactory, module: g.Module };
    g.ModuleFactory = ModuleFactory;
    g.Module = {
      instantiateWasm(imports: WebAssembly.Imports, done: (i: WebAssembly.Instance) => void) {
        WebAssembly.instantiate(wasm, imports).then((r) => done(r.instance));
        return {};
      },
    };
    try {
      return await create();
    } finally {
      g.ModuleFactory = had.factory;
      g.Module = had.module;
    }
  };
  const next = globalsLock.then(run, run);
  globalsLock = next.catch(() => {});
  return next;
}

async function withGpuFallback<T>(make: (delegate: 'GPU' | 'CPU') => Promise<T>): Promise<T> {
  try {
    return await make('GPU');
  } catch (err) {
    console.warn('[SpookCam] GPU delegate unavailable, using CPU', err);
    return make('CPU');
  }
}

/** False when the page's CSP forbids compiling WebAssembly (no 'wasm-unsafe-eval'). */
export function pageCanRunWasm(): boolean {
  try {
    new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    return true;
  } catch {
    return false;
  }
}

type Lazy<T> = { value?: T; pending?: Promise<T>; error?: unknown };

/** Runs MediaPipe in the current realm, synchronously per frame. */
export class LocalDetectors implements DetectorBackend {
  private face: Lazy<FaceLandmarker> = {};
  private seg: Lazy<ImageSegmenter> = {};
  private hand: Lazy<HandLandmarker> = {};
  private wasm?: Promise<ArrayBuffer>;
  private lastTs = 0;

  constructor(private readonly load: AssetLoader) {}

  get loading(): boolean {
    return [this.face, this.seg, this.hand].some((l) => !!(l.pending && !l.value && !l.error));
  }

  get error(): string | undefined {
    const e = this.face.error ?? this.seg.error ?? this.hand.error;
    return e ? String((e as Error).message ?? e) : undefined;
  }

  private wasmBytes() {
    return (this.wasm ??= this.load('wasm'));
  }

  private ensure<T>(slot: Lazy<T>, create: () => Promise<T>): T | undefined {
    if (slot.value || slot.error) return slot.value;
    slot.pending ??= create().then(
      (v) => (slot.value = v),
      (e) => {
        slot.error = e;
        console.error('[SpookCam] model failed to load', e);
        throw e;
      },
    );
    slot.pending.catch(() => {});
    return undefined;
  }

  private faceLandmarker(): FaceLandmarker | undefined {
    return this.ensure(this.face, async () => {
      const [wasm, model] = await Promise.all([this.wasmBytes(), this.load('face')]);
      return withGpuFallback((delegate) =>
        withWasmGlobals(wasm, () =>
          FaceLandmarker.createFromOptions(FILESET, {
            baseOptions: { modelAssetBuffer: new Uint8Array(model), delegate },
            runningMode: 'VIDEO',
            numFaces: MAX_FACES,
            outputFaceBlendshapes: true,
            minFaceDetectionConfidence: 0.5,
            minFacePresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
          }),
        ),
      );
    });
  }

  private segmenter(): ImageSegmenter | undefined {
    return this.ensure(this.seg, async () => {
      const [wasm, model] = await Promise.all([this.wasmBytes(), this.load('segmenter')]);
      return withGpuFallback((delegate) =>
        withWasmGlobals(wasm, () =>
          ImageSegmenter.createFromOptions(FILESET, {
            baseOptions: { modelAssetBuffer: new Uint8Array(model), delegate },
            runningMode: 'VIDEO',
            outputConfidenceMasks: true,
            outputCategoryMask: false,
          }),
        ),
      );
    });
  }

  private handLandmarker(): HandLandmarker | undefined {
    return this.ensure(this.hand, async () => {
      const [wasm, model] = await Promise.all([this.wasmBytes(), this.load('hand')]);
      return withGpuFallback((delegate) =>
        withWasmGlobals(wasm, () =>
          HandLandmarker.createFromOptions(FILESET, {
            baseOptions: { modelAssetBuffer: new Uint8Array(model), delegate },
            runningMode: 'VIDEO',
            numHands: 2,
            minHandDetectionConfidence: 0.5,
            minHandPresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
          }),
        ),
      );
    });
  }

  warm(want: { face: boolean; mask: boolean; hands?: boolean }) {
    if (want.mask) this.segmenter();
    if (want.face) this.faceLandmarker();
    if (want.hands) this.handLandmarker();
  }

  /** MediaPipe VIDEO mode requires strictly increasing timestamps across all callers. */
  private timestamp(): number {
    const now = performance.now();
    this.lastTs = now > this.lastTs ? now : this.lastTs + 0.01;
    return this.lastTs;
  }

  detect(frame: TexImageSource, want: DetectRequest): DetectResult {
    const result: DetectResult = { faces: null, mask: null, blend: null, hands: null };
    if (want.mask) {
      this.segmenter()?.segmentForVideo(frame, this.timestamp(), (r) => {
        const mask = r.confidenceMasks?.[0];
        if (!mask) return;
        const f = mask.getAsFloat32Array();
        const data = new Uint8Array(f.length);
        for (let i = 0; i < f.length; i++) data[i] = f[i] * 255;
        result.mask = { data, width: mask.width, height: mask.height };
      });
    }
    if (want.face) {
      const lm = this.faceLandmarker();
      if (lm) {
        const r = lm.detectForVideo(frame, this.timestamp());
        const found = r.faceLandmarks.slice(0, want.maxFaces);
        result.blend = found.map((_, i) => {
          const cats = r.faceBlendshapes?.[i]?.categories ?? [];
          return Float32Array.from(BLENDSHAPES, (name) => cats.find((c) => c.categoryName === name)?.score ?? 0);
        });
        result.faces = found.map((pts) => {
          const a = new Float32Array(pts.length * 2);
          for (let j = 0; j < pts.length; j++) {
            a[j * 2] = pts[j].x;
            a[j * 2 + 1] = pts[j].y;
          }
          return a;
        });
      }
    }
    if (want.hands) {
      const hl = this.handLandmarker();
      if (hl) {
        result.hands = hl.detectForVideo(frame, this.timestamp()).landmarks.map((pts) => {
          const a = new Float32Array(pts.length * 2);
          for (let j = 0; j < pts.length; j++) {
            a[j * 2] = pts[j].x;
            a[j * 2 + 1] = pts[j].y;
          }
          return a;
        });
      }
    }
    return result;
  }

  close() {
    this.face.value?.close();
    this.seg.value?.close();
    this.hand.value?.close();
  }
}

// ── Remote: MediaPipe in a hidden extension iframe, for pages whose CSP blocks WebAssembly ──

export type RemoteRequest = { spookcam: 'detect'; bitmap: ImageBitmap } & DetectRequest;
export type RemoteResponse = {
  spookcam: 'result';
  faces: Float32Array[] | null;
  mask: SegmentationMask | null;
  blend: Float32Array[] | null;
  hands: Float32Array[] | null;
  loading: boolean;
  error?: string;
};
const REMOTE_MAX_WIDTH = 640;

/**
 * Same contract as LocalDetectors, but results arrive asynchronously: each call submits the
 * frame (if the iframe is idle) and returns the latest results, typically one frame old.
 */
export class RemoteDetectors implements DetectorBackend {
  private iframe: HTMLIFrameElement;
  private ready: Promise<void>;
  private origin: string;
  private busy = false;
  private faces: Float32Array[] | null = null;
  private blend: Float32Array[] | null = null;
  private hands: Float32Array[] | null = null;
  private freshMask: SegmentationMask | null = null;
  private remoteLoading = true;
  private remoteError?: string;

  constructor(url: string) {
    this.origin = new URL(url).origin;
    this.iframe = document.createElement('iframe');
    this.iframe.src = url;
    this.iframe.setAttribute('aria-hidden', 'true');
    this.iframe.tabIndex = -1;
    // Not display:none — hidden cross-origin frames can get throttled.
    this.iframe.style.cssText = 'position:fixed;width:1px;height:1px;left:-10px;top:-10px;opacity:0;border:0;pointer-events:none;';
    this.ready = new Promise((r) => this.iframe.addEventListener('load', () => r(), { once: true }));
    (document.body ?? document.documentElement).append(this.iframe);
    window.addEventListener('message', this.onMessage);
  }

  get loading() {
    return this.remoteLoading;
  }

  get error() {
    return this.remoteError;
  }

  private onMessage = (e: MessageEvent) => {
    if (e.origin !== this.origin || e.source !== this.iframe.contentWindow) return;
    const msg = e.data as RemoteResponse;
    if (msg?.spookcam !== 'result') return;
    this.busy = false;
    this.remoteLoading = msg.loading;
    this.remoteError = msg.error;
    if (msg.faces) this.faces = msg.faces;
    if (msg.blend) this.blend = msg.blend;
    if (msg.hands) this.hands = msg.hands;
    if (msg.mask) this.freshMask = msg.mask;
  };

  warm() {}

  detect(frame: VideoFrame, want: DetectRequest): DetectResult {
    if (!this.busy && (want.face || want.mask || want.hands)) {
      this.busy = true;
      const scale = Math.min(1, REMOTE_MAX_WIDTH / frame.displayWidth);
      const copy = frame.clone();
      createImageBitmap(copy, { resizeWidth: Math.round(frame.displayWidth * scale), resizeHeight: Math.round(frame.displayHeight * scale) })
        .then(async (bitmap) => {
          await this.ready;
          const req: RemoteRequest = { spookcam: 'detect', bitmap, ...want };
          this.iframe.contentWindow!.postMessage(req, this.origin, [bitmap]);
        })
        .catch(() => (this.busy = false))
        .finally(() => copy.close());
    }
    const mask = want.mask ? this.freshMask : null;
    if (want.mask) this.freshMask = null;
    return { faces: want.face ? this.faces : null, mask, blend: want.face ? this.blend : null, hands: want.hands ? this.hands : null };
  }

  close() {
    window.removeEventListener('message', this.onMessage);
    this.iframe.remove();
  }
}
