const $ = id => document.getElementById(id);

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function showMsg(elId, type, html) {
  $(elId).innerHTML = `<div class="msg ${type}">${html}</div>`;
}
function clearMsg(elId) { $(elId).innerHTML = ''; }

document.addEventListener('DOMContentLoaded', () => {
  $('ui-run-btn').addEventListener('click', runUiMode);
  $('ui-fnr-btn').addEventListener('click', runFindReplace);
  $('ui-diagnose-btn').addEventListener('click', diagnoseUi);
  $('date-btn').addEventListener('click', insertDate);
  $('date-btn').textContent = `Insert ${todayYmd()}`;
});

function todayYmd() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) { /* fall back to execCommand */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (_) {
    return false;
  }
}

// Insert today's date into the field that's focused on the Ads Manager tab
// (same path as the Alt+Shift+D shortcut). If nothing editable is focused
// there, copy the date to the clipboard instead.
async function insertDate() {
  const btn = $('date-btn');
  let date = todayYmd();
  btn.disabled = true;
  clearMsg('date-msg');

  let inserted = false;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && /facebook\.com\/.*adsmanager/i.test(tab.url || '')) {
      await ensureContentScript(tab.id);
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'insertTodayDate' });
      inserted = !!(resp && resp.ok && resp.result && resp.result.inserted);
      if (inserted && resp.result.date) date = resp.result.date;
    }
  } catch (_) { /* fall back to the clipboard */ }

  if (inserted) {
    showMsg('date-msg', 'success', `Inserted <span class="mono">${esc(date)}</span>.`);
    // Close so focus goes straight back to the field and typing can continue.
    setTimeout(() => window.close(), 700);
  } else if (await copyText(date)) {
    showMsg('date-msg', 'info',
      `Copied <span class="mono">${esc(date)}</span> — click the ad name field and press <kbd>Ctrl</kbd>+<kbd>V</kbd>.`);
  } else {
    showMsg('date-msg', 'error', `Couldn't insert or copy. Today is <span class="mono">${esc(date)}</span>.`);
  }
  btn.disabled = false;
}

async function ensureContentScript(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    if (r && r.ok) return;
  } catch (_) { /* not loaded */ }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

async function runUiMode() {
  const btn = $('ui-run-btn');
  btn.disabled = true;
  clearMsg('ui-msg');
  showMsg('ui-msg', 'info', 'Running… watch the Ads Manager tab.');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/facebook\.com\/.*adsmanager/i.test(tab.url || '')) {
      throw new Error('Switch to the Ads Manager tab first.');
    }
    await ensureContentScript(tab.id);
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'runUiDuplicate' });

    if (response && response.ok) {
      const note = response.result && response.result.note ? response.result.note : '';
      const finished = response.result && response.result.finishedAt ? response.result.finishedAt : '';
      const isFullSuccess = finished === 'find-and-replace-applied';
      showMsg('ui-msg', isFullSuccess ? 'success' : 'info',
        (isFullSuccess ? 'All done.' : 'Partial.') + ' ' + esc(note)
      );
    } else {
      const errMsg = response && response.error ? response.error : 'Unknown error';
      showMsg('ui-msg', 'error', `Stopped: ${esc(errMsg)}`);
    }
  } catch (e) {
    showMsg('ui-msg', 'error', esc(e.message));
  }
  btn.disabled = false;
}

async function runFindReplace() {
  const btn = $('ui-fnr-btn');
  btn.disabled = true;
  clearMsg('ui-msg');
  showMsg('ui-msg', 'info', 'Filling Find & Replace…');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab.');
    await ensureContentScript(tab.id);
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'applyFindReplace' });
    if (resp && resp.ok && resp.navigating) {
      showMsg('ui-msg', 'info', 'This edit view has no Find and replace — switching to the table view, where " - Copy" gets stripped automatically in a few seconds. If the names still end in " - Copy", click this button again there.');
    } else if (resp && resp.ok) {
      showMsg('ui-msg', 'success', 'Filled " - Copy" → "" and clicked Save to draft.');
    } else {
      showMsg('ui-msg', 'error', `Stopped: ${esc(resp && resp.error ? resp.error : 'unknown')}`);
    }
  } catch (e) {
    showMsg('ui-msg', 'error', esc(e.message));
  }
  btn.disabled = false;
}

async function diagnoseUi() {
  const out = $('ui-diag');
  out.style.display = 'block';
  out.textContent = 'Running…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab.');
    await ensureContentScript(tab.id);
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'diagnose' });
    out.textContent = JSON.stringify(resp.result, null, 2);
  } catch (e) {
    out.textContent = 'Error: ' + e.message;
  }
}
