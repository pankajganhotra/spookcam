// MAIN world, document_start. Kept tiny: it only intercepts getUserMedia and pipes camera
// frames through the engine, which is injected on demand by the service worker.
import type { FrameProcessor, SpookEngine } from '../engine/engine';
import { ENGINE_KEY, ENGINE_READY_EVENT, listen, post, type BridgeToPage } from '../shared/protocol';
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings';
import { wrapVideoTrack } from '../shared/track';
import type { EngineFactory } from '../engine/main';
import type { AssetName } from '../engine/detectors';

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

  const loadAsset = (name: AssetName) =>
    new Promise<ArrayBuffer>((resolve, reject) => {
      const id = nextAssetId++;
      pendingAssets.set(id, { resolve, reject });
      post({ type: 'asset-request', id, name });
    });

  const createEngine = () => {
    const factory = window[ENGINE_KEY];
    if (!factory || engine) return;
    engine = factory.create(loadAsset, settings ?? DEFAULT_SETTINGS, (status) => post({ type: 'status', status }), detectorUrl);
    engine.setAudioProvider(audioProvider);
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

  // Snap detection listens to the call's own microphone. We only ever *clone* the page's track,
  // and if the page stops it (e.g. to mute) we stop listening instead of reopening the mic.
  let pageAudio: MediaStreamTrack | undefined;
  const watchPageAudio = (stream: MediaStream) => {
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    pageAudio = track;
    const stop = track.stop.bind(track);
    Object.defineProperty(track, 'stop', {
      configurable: true,
      writable: true,
      value: () => {
        stop();
        engine?.setAudioProvider(audioProvider); // re-sync: listener closes
      },
    });
    engine?.setAudioProvider(audioProvider);
  };
  const audioProvider = async (): Promise<MediaStreamTrack | null> => {
    if (pageAudio) return pageAudio.readyState === 'live' ? pageAudio.clone() : null;
    // Camera-only page: open our own unprocessed capture (snaps survive noise suppression better).
    const own = await original({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    return own.getAudioTracks()[0] ?? null;
  };

  const patched = async function getUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream> {
    const stream = await original(constraints);
    watchPageAudio(stream);
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
