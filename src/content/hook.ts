// MAIN world, document_start. Kept tiny: it only intercepts getUserMedia and pipes camera
// frames through the engine, which is injected on demand by the service worker.
import type { FrameProcessor, SpookEngine } from '../engine/engine';
import { ENGINE_KEY, ENGINE_READY_EVENT, listen, post, type BridgeToPage } from '../shared/protocol';
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings';
import { mirrorTrack, wrapVideoTrack } from '../shared/track';
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
    if (callMixer) engine.setCallMixer(callMixer.ctx, callMixer.bus);
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

  // "Everyone in the call" scare sounds: the outgoing mic becomes mic + sound-effect bus.
  let callMixer: { ctx: AudioContext; bus: GainNode } | undefined;
  const mixIntoCall = async (track: MediaStreamTrack): Promise<MediaStreamTrack> => {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    if (ctx.state !== 'running') await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 400))]);
    if (ctx.state !== 'running') {
      // Autoplay policy blocked audio: never risk sending a silent mic — pass the real one through.
      console.warn(`[SpookCam] audio engine is ${ctx.state}; scare sounds will play only on this device`);
      void ctx.close();
      return track;
    }
    const dest = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(new MediaStream([track])).connect(dest);
    const bus = ctx.createGain();
    bus.connect(dest);
    callMixer = { ctx, bus };
    engine?.setCallMixer(ctx, bus);
    return mirrorTrack(dest.stream.getAudioTracks()[0], track, () => void ctx.close());
  };

  const patched = async function getUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream> {
    const stream = await original(constraints);
    watchPageAudio(stream);
    const hasVideo = !!constraints?.video && stream.getVideoTracks().length > 0;
    const hasAudio = stream.getAudioTracks().length > 0;
    if (!hasVideo && !hasAudio) return stream;
    await Promise.race([settingsArrived, new Promise((r) => setTimeout(r, 1500))]);
    const s = settings ?? DEFAULT_SETTINGS;
    if (!s.enabled) return stream;
    const mixAudio = hasAudio && s.sounds === 'call';
    if (!hasVideo && !mixAudio) return stream;
    try {
      const tracks = await Promise.all(
        stream.getTracks().map(async (t) => {
          if (t.kind === 'video') return hasVideo ? wrapVideoTrack(t, processorFactory()) : t;
          return mixAudio ? mixIntoCall(t) : t;
        }),
      );
      return new MediaStream(tracks);
    } catch (err) {
      console.error('[SpookCam] could not attach to camera, passing through', err);
      return stream;
    }
  };
  Object.defineProperty(patched, 'toString', { value: () => 'function getUserMedia() { [native code] }' });
  md.getUserMedia = patched;
})();
