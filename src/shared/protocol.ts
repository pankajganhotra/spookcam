import type { EngineCommand, EngineStatus, Settings } from './settings';
import type { AssetName } from '../engine/detectors';

/** Tag on every window.postMessage between the MAIN-world hook and the isolated bridge. */
export const CHANNEL = '__spookcam__';

export const ASSET_PATHS: Record<AssetName, string> = {
  wasm: 'wasm/vision.wasm',
  face: 'models/face_landmarker.task',
  segmenter: 'models/selfie_segmenter.tflite',
};

/** Global (MAIN world) slot where the lazily injected engine bundle registers itself. */
export const ENGINE_KEY = Symbol.for('spookcam.engine');
export const ENGINE_READY_EVENT = 'spookcam:engine-ready';

export type PageToBridge =
  | { type: 'hello' }
  | { type: 'need-engine' }
  | { type: 'asset-request'; id: number; name: AssetName }
  | { type: 'status'; status: EngineStatus };

export type BridgeToPage =
  | { type: 'settings'; settings: Settings; detectorUrl: string }
  | { type: 'command'; cmd: EngineCommand }
  | { type: 'asset'; id: number; buffer?: ArrayBuffer; error?: string };

/** chrome.runtime messages (popup / background / bridge / studio). */
export type RuntimeMessage =
  | { type: 'inject-engine' }
  | { type: 'command'; cmd: EngineCommand }
  | { type: 'get-status' }
  | { type: 'status'; status: EngineStatus };

export function post(msg: PageToBridge | BridgeToPage, transfer: Transferable[] = []) {
  window.postMessage({ [CHANNEL]: msg }, '*', transfer);
}

export function listen<T extends PageToBridge | BridgeToPage>(handler: (msg: T) => void) {
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data !== 'object') return;
    const msg = (e.data as Record<string, unknown>)[CHANNEL];
    if (msg && typeof msg === 'object' && 'type' in msg) handler(msg as T);
  });
}
