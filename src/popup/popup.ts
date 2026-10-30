import '../ui/theme.css';
import './popup.css';
import type { RuntimeMessage } from '../shared/protocol';
import type { EngineCommand, EngineStatus } from '../shared/settings';
import { mountControls } from '../ui/controls';

const studioUrl = chrome.runtime.getURL('studio.html');

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getStatus(): Promise<EngineStatus | null> {
  const tab = await activeTab();
  if (tab?.url?.startsWith(studioUrl)) return chrome.runtime.sendMessage({ type: 'get-status' } satisfies RuntimeMessage);
  if (tab?.id === undefined) return null;
  return (await chrome.tabs.sendMessage(tab.id, { type: 'get-status' } satisfies RuntimeMessage).catch(() => null)) ?? null;
}

async function sendCommand(cmd: EngineCommand) {
  const msg: RuntimeMessage = { type: 'command', cmd };
  const tab = await activeTab();
  if (tab?.id !== undefined) chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
  chrome.runtime.sendMessage(msg).catch(() => {});
}

const tab = await activeTab();
const site = document.getElementById('site')!;
try {
  const url = new URL(tab?.url ?? '');
  site.textContent = url.href.startsWith(studioUrl) ? 'Preview studio' : url.protocol.startsWith('http') ? url.hostname : 'This page can’t use a camera';
} catch {
  site.textContent = '';
}

const { master } = await mountControls({
  root: document.getElementById('controls')!,
  sendCommand,
  getStatus,
  idleHint: 'No camera in this tab yet — join a call or open the studio',
});
document.getElementById('master')!.append(master);

document.getElementById('studio')!.addEventListener('click', async () => {
  const [existing] = await chrome.tabs.query({ url: `${studioUrl}*` });
  if (existing?.id !== undefined) await chrome.tabs.update(existing.id, { active: true });
  else await chrome.tabs.create({ url: studioUrl });
  window.close();
});
