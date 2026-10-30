// Dev helper: open chrome-extension://<id>/reload.html to reload the unpacked extension
// (picks up a new manifest and content scripts) and reopen the studio.
chrome.tabs.create({ url: chrome.runtime.getURL('studio.html') }).finally(() => chrome.runtime.reload());
