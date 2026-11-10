// Background service worker — listens for the Ctrl+Shift+E command and
// triggers the UI-mode duplicate flow on the active Ads Manager tab.

// Map of command name → message type to send to the content script.
const COMMANDS = {
  'duplicate-and-cleanup': 'runUiDuplicate',
  'toggle-panels': 'togglePanels',
  'insert-today-date': 'insertTodayDate'
};

chrome.commands.onCommand.addListener(async (command) => {
  const msgType = COMMANDS[command];
  if (!msgType) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  if (!/facebook\.com\/.*adsmanager/i.test(tab.url || '')) {
    console.warn(`[FB Dup] ${command} pressed outside Ads Manager — ignoring.`);
    return;
  }

  // Make sure the content script is loaded.
  let alive = false;
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'ping' });
    alive = r && r.ok;
  } catch (_) {}

  if (!alive) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
    } catch (e) {
      console.error('[FB Dup] failed to inject content script', e);
      return;
    }
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: msgType });
  } catch (e) {
    console.error(`[FB Dup] failed to send ${msgType}`, e);
  }
});
