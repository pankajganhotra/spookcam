// Isolated world. Relays settings/commands into the page and serves extension assets
// (fetched here, so the page's CSP never sees a chrome-extension:// request).
import { ASSET_PATHS, listen, post, type PageToBridge, type RuntimeMessage } from '../shared/protocol';
import { normalizeSettings, STORAGE_KEY, type EngineStatus } from '../shared/settings';

const detectorUrl = chrome.runtime.getURL('detector.html');
let lastStatus: EngineStatus | undefined;
let lastReported = '';

async function pushSettings() {
  const raw = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  post({ type: 'settings', settings: normalizeSettings(raw), detectorUrl });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) post({ type: 'settings', settings: normalizeSettings(changes[STORAGE_KEY].newValue), detectorUrl });
});

listen<PageToBridge>(async (msg) => {
  switch (msg.type) {
    case 'hello':
      void pushSettings();
      break;
    case 'need-engine':
      void chrome.runtime.sendMessage({ type: 'inject-engine' } satisfies RuntimeMessage);
      break;
    case 'asset-request':
      try {
        const url = chrome.runtime.getURL(ASSET_PATHS[msg.name]);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = await res.arrayBuffer();
        post({ type: 'asset', id: msg.id, buffer }, [buffer]);
      } catch (err) {
        post({ type: 'asset', id: msg.id, error: String(err) });
      }
      break;
    case 'status': {
      lastStatus = msg.status;
      // Tell the service worker only when something badge-worthy changed.
      const key = `${msg.status.cameras}|${msg.status.phase}|${!!msg.status.error}`;
      if (key !== lastReported) {
        lastReported = key;
        chrome.runtime.sendMessage({ type: 'status', status: msg.status } satisfies RuntimeMessage).catch(() => {});
      }
      break;
    }
  }
});

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  if (msg.type === 'command') post({ type: 'command', cmd: msg.cmd });
  else if (msg.type === 'get-status' && lastStatus && lastStatus.cameras > 0) {
    sendResponse(lastStatus);
    return false;
  }
  return false;
});

void pushSettings();
