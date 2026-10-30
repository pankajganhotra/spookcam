// Entry for dist/engine.js — injected into the page's MAIN world only once a camera is in use.
import type { EngineStatus, Settings } from '../shared/settings';
import { ENGINE_KEY, ENGINE_READY_EVENT } from '../shared/protocol';
import { LocalDetectors, pageCanRunWasm, RemoteDetectors, type AssetLoader } from './detectors';
import { SpookEngine } from './engine';

export interface EngineFactory {
  create(load: AssetLoader, settings: Settings, onStatus: (s: EngineStatus) => void, detectorUrl: string): SpookEngine;
}

const slot = window as unknown as Record<symbol, EngineFactory | undefined>;
if (!slot[ENGINE_KEY]) {
  Object.defineProperty(window, ENGINE_KEY, {
    value: {
      // Pages whose CSP forbids WebAssembly get MediaPipe in an extension iframe instead.
      create: (load, settings, onStatus, detectorUrl) =>
        new SpookEngine(pageCanRunWasm() ? new LocalDetectors(load) : new RemoteDetectors(detectorUrl), settings, onStatus),
    } satisfies EngineFactory,
    configurable: false,
  });
  window.dispatchEvent(new Event(ENGINE_READY_EVENT));
}
