// Hidden iframe used on pages whose CSP blocks WebAssembly: runs MediaPipe under the
// extension's own CSP and answers detection requests from the page's SpookCam engine.
import { LocalDetectors, type AssetName, type RemoteRequest, type RemoteResponse } from '../engine/detectors';
import { ASSET_PATHS } from '../shared/protocol';

const detectors = new LocalDetectors(async (name: AssetName) => {
  const res = await fetch(chrome.runtime.getURL(ASSET_PATHS[name]));
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.arrayBuffer();
});

window.addEventListener('message', (e) => {
  const req = e.data as RemoteRequest;
  if (req?.spookcam !== 'detect' || !e.source) return;
  let response: RemoteResponse;
  try {
    detectors.warm(req);
    const { faces, mask } = detectors.detect(req.bitmap, req);
    response = { spookcam: 'result', faces, mask, loading: detectors.loading, error: detectors.error };
  } catch (err) {
    response = { spookcam: 'result', faces: null, mask: null, loading: false, error: String((err as Error)?.message ?? err) };
  } finally {
    req.bitmap.close();
  }
  const transfer: Transferable[] = [...(response.faces ?? []).map((f) => f.buffer), ...(response.mask ? [response.mask.data.buffer] : [])];
  (e.source as Window).postMessage(response, { targetOrigin: e.origin, transfer });
});
