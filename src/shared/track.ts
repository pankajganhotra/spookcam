import type { FrameProcessor } from '../engine/engine';

type TrackProcessorCtor = new (init: { track: MediaStreamTrack; maxBufferSize?: number }) => { readable: ReadableStream<VideoFrame> };
type TrackGeneratorCtor = new (init: { kind: 'video' }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> };

const G = globalThis as unknown as { MediaStreamTrackProcessor?: TrackProcessorCtor; MediaStreamTrackGenerator?: TrackGeneratorCtor };

/**
 * Returns a track that carries `source` through the effect engine. `getProcessor` is polled per
 * frame until it returns a processor, so frames flow untouched while the engine is still loading.
 */
export function wrapVideoTrack(source: MediaStreamTrack, getProcessor: () => FrameProcessor | null): MediaStreamTrack {
  if (G.MediaStreamTrackProcessor && G.MediaStreamTrackGenerator) return wrapWithBreakoutBox(source, getProcessor);
  return wrapWithCanvas(source, getProcessor);
}

function runProcessor(frame: VideoFrame, proc: FrameProcessor | null): VideoFrame {
  if (!proc) return frame;
  const out = proc.process(frame);
  if (!out) return frame;
  frame.close();
  return out;
}

/** Insertable Streams: frame-accurate, keeps running in background tabs. */
function wrapWithBreakoutBox(source: MediaStreamTrack, getProcessor: () => FrameProcessor | null) {
  const reader = new G.MediaStreamTrackProcessor!({ track: source, maxBufferSize: 1 });
  const generator = new G.MediaStreamTrackGenerator!({ kind: 'video' });
  let proc: FrameProcessor | null = null;
  const transform = new TransformStream<VideoFrame, VideoFrame>({
    transform(frame, controller) {
      proc ??= getProcessor();
      controller.enqueue(runProcessor(frame, proc));
    },
  });
  reader.readable
    .pipeThrough(transform)
    .pipeTo(generator.writable)
    .catch(() => {})
    .finally(() => proc?.close());
  return mirrorTrack(generator, source);
}

/** Fallback for browsers without MediaStreamTrackProcessor on window. */
function wrapWithCanvas(source: MediaStreamTrack, getProcessor: () => FrameProcessor | null) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([source]);
  void video.play().catch(() => {});
  const canvas = document.createElement('canvas');
  const settings = source.getSettings();
  canvas.width = settings.width ?? 640;
  canvas.height = settings.height ?? 480;
  const ctx = canvas.getContext('2d')!;
  const out = canvas.captureStream(settings.frameRate ?? 30).getVideoTracks()[0];
  let proc: FrameProcessor | null = null;
  let stopped = false;
  const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
    if (stopped) return;
    if (video.videoWidth) {
      proc ??= getProcessor();
      const frame = runProcessor(new VideoFrame(video, { timestamp: Math.round(meta.mediaTime * 1e6) }), proc);
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      ctx.drawImage(frame, 0, 0);
      frame.close();
    }
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
  source.addEventListener('ended', () => {
    stopped = true;
    proc?.close();
  });
  return mirrorTrack(out, source, () => {
    stopped = true;
    proc?.close();
  });
}

/**
 * Makes the processed track impersonate the real camera track: same label, settings,
 * capabilities and constraints. Clones share the camera, which is released only once the
 * track and every clone of it have been stopped.
 */
export function mirrorTrack(out: MediaStreamTrack, source: MediaStreamTrack, onStop?: () => void): MediaStreamTrack {
  const live = new Set<MediaStreamTrack>();

  const release = (t: MediaStreamTrack) => {
    if (!live.delete(t) || live.size) return;
    source.stop();
    onStop?.();
  };

  const impersonate = (t: MediaStreamTrack) => {
    live.add(t);
    const stopSelf = t.stop.bind(t);
    const cloneSelf = t.clone.bind(t);
    const define = (name: string, value: unknown) => Object.defineProperty(t, name, { value, configurable: true, writable: true });
    Object.defineProperty(t, 'label', { get: () => source.label, configurable: true });
    define('getSettings', () => ({ ...source.getSettings() }));
    define('getCapabilities', () => source.getCapabilities?.() ?? {});
    define('getConstraints', () => source.getConstraints());
    define('applyConstraints', (c?: MediaTrackConstraints) => source.applyConstraints(c));
    define('clone', () => impersonate(cloneSelf()));
    define('stop', () => {
      stopSelf();
      release(t);
    });
    source.addEventListener('ended', () => {
      if (t.readyState === 'ended') return;
      stopSelf();
      t.dispatchEvent(new Event('ended'));
    });
    source.addEventListener('mute', () => t.dispatchEvent(new Event('mute')));
    source.addEventListener('unmute', () => t.dispatchEvent(new Event('unmute')));
    return t;
  };

  return impersonate(out);
}
