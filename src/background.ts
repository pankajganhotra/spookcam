import type { RuntimeMessage } from './shared/protocol';
import { DEFAULT_SETTINGS, STORAGE_KEY, type EngineCommand, type EngineStatus } from './shared/settings';

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  if (!stored[STORAGE_KEY]) await chrome.storage.local.set({ [STORAGE_KEY]: DEFAULT_SETTINGS });
  if (reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL('studio.html?welcome=1') });
});

/** Sends a command to every frame of the active tab, plus any open studio page. */
export async function broadcastCommand(cmd: EngineCommand) {
  const msg: RuntimeMessage = { type: 'command', cmd };
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id !== undefined) chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
  chrome.runtime.sendMessage(msg).catch(() => {});
}

chrome.commands.onCommand.addListener((command) => {
  if (command === 'snap' || command === 'relearn-background') void broadcastCommand(command);
});

function updateBadge(tabId: number, status: EngineStatus) {
  const live = status.cameras > 0;
  const text = status.error ? '!' : !live ? '' : status.phase === 'gone' ? '👻' : 'ON';
  void chrome.action.setBadgeText({ tabId, text });
  void chrome.action.setBadgeBackgroundColor({ tabId, color: status.error ? '#b3261e' : '#ff6a00' });
  void chrome.action.setBadgeTextColor?.({ tabId, color: '#ffffff' });
}

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, sender) => {
  const tabId = sender.tab?.id;
  if (msg.type === 'inject-engine' && tabId !== undefined) {
    chrome.scripting
      .executeScript({
        target: { tabId, frameIds: [sender.frameId ?? 0] },
        world: 'MAIN',
        injectImmediately: true,
        files: ['engine.js'],
      })
      .catch((err) => console.error('[SpookCam] engine injection failed', err));
  } else if (msg.type === 'status' && tabId !== undefined) {
    updateBadge(tabId, msg.status);
  }
  return false;
});
