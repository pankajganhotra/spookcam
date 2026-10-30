// MAIN world, document_start. Kept tiny: it only intercepts getUserMedia and pipes camera
// frames through the engine, which is injected on demand by the service worker.
import type { FrameProcessor, SpookEngine } from '../engine/engine';
import { ENGINE_KEY, ENGINE_READY_EVENT, listen, post, type BridgeToPage } from '../shared/protocol';
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings';
import { wrapVideoTrack } from '../shared/track';
import type { EngineFactory } from '../engine/main';

declare global {
  interface Window {
    [ENGINE_KEY]?: EngineFactory;
  }
}

(() => {
  const md = navigator.mediaDevices;
  if (!md?.getUserMedia || (md as unknown as Record<symbol, boolean>)[ENGINE_KEY]) return;
  (md as unknown as Record<symbol, boolean>)[ENGINE_KEY] = true;

  let settings: Settings | undefined;
  let detectorUrl = '';
  let settingsReady: () => void;
  const settingsArrived = new Promise<void>((r) => (settingsReady = r));
  let engine: SpookEngine | null = null;
  let engineRequested = false;
  let nextAssetId = 1;
  const pendingAssets = new Map<number, { resolve: (b: ArrayBuffer) => void; reject: (e: Error) => void }>();

  listen<BridgeToPage>((msg) => {
    switch (msg.type) {
      case 'settings':
        settings = msg.settings;
        detectorUrl = msg.detectorUrl;
        settingsReady();
        engine?.setSettings(msg.settings);
        break;
      case 'command':
        engine?.command(msg.cmd);
        break;
      case 'asset': {
        const p = pendingAssets.get(msg.id);
        pendingAssets.delete(msg.id);
        if (msg.buffer) p?.resolve(msg.buffer);
        else p?.reject(new Error(msg.error ?? 'asset load failed'));
        break;
      }
    }
  });
  post({ type: 'hello' });

  const loadAsset = (name: 'wasm' | 'face' | 'segmenter') =>
    new Promise<ArrayBuffer>((resolve, reject) => {
      const id = nextAssetId++;
      pendingAssets.set(id, { resolve, reject });
      post({ type: 'asset-request', id, name });
    });

  const createEngine = () => {
    const factory = window[ENGINE_KEY];
    if (!factory || engine) return;
    engine = factory.create(loadAsset, settings ?? DEFAULT_SETTINGS, (status) => post({ type: 'status', status }), detectorUrl);
  };
  window.addEventListener(ENGINE_READY_EVENT, createEngine);

  /** Polled per frame by the track wrapper; triggers the engine injection on first call. */
  const processorFactory = () => {
    let proc: FrameProcessor | null = null;
    return () => {
      if (proc) return proc;
      if (!engine) {
        if (!engineRequested) {
          engineRequested = true;
          post({ type: 'need-engine' });
        }
        createEngine();
        return null;
      }
      return (proc = engine.createPipeline());
    };
  };

  const original = md.getUserMedia.bind(md);
  const patched = async function getUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream> {
    const stream = await original(constraints);
    if (!constraints?.video || !stream.getVideoTracks().length) return stream;
    await Promise.race([settingsArrived, new Promise((r) => setTimeout(r, 1500))]);
    if (!(settings ?? DEFAULT_SETTINGS).enabled) return stream;
    try {
      const tracks = stream.getTracks().map((t) => (t.kind === 'video' ? wrapVideoTrack(t, processorFactory()) : t));
      return new MediaStream(tracks);
    } catch (err) {
      console.error('[SpookCam] could not attach to camera, passing through', err);
      return stream;
    }
  };
  Object.defineProperty(patched, 'toString', { value: () => 'function getUserMedia() { [native code] }' });
  md.getUserMedia = patched;
})();
