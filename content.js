// Content script — runs on Ads Manager pages.
// Drives the FB UI by dispatching keyboard events and clicking elements
// found by text / role / aria-label.

const LOG_PREFIX = '[FB Dup]';
// Trace that persists across the run for post-mortem debugging.
// Mirrored into a hidden DOM element so the page world (and external
// debuggers like Chrome DevTools) can read it — content-script `window`
// is in the isolated world and not accessible from page scripts.
const TRACE = [];
function log(...args) {
  console.log(LOG_PREFIX, ...args);
  try {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    TRACE.push({ t: Date.now(), msg });
    let el = document.getElementById('__fb_dup_trace__');
    if (!el) {
      el = document.createElement('script');
      el.id = '__fb_dup_trace__';
      el.type = 'application/json';
      (document.documentElement || document.head || document.body).appendChild(el);
    }
    el.textContent = JSON.stringify(TRACE);
  } catch (_) {}
}

// ---------- waiting ----------

async function waitFor(fn, { timeout = 10000, interval = 200, label = '' } = {}) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeout) {
    try {
      const v = fn();
      if (v) return v;
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`Timeout waiting for: ${label || 'condition'}${lastErr ? ' — ' + lastErr.message : ''}`);
}

// ---------- DOM matching ----------

function elementDepth(el) {
  let d = 0, p = el;
  while (p && p.parentElement) { d++; p = p.parentElement; }
  return d;
}

function isVisible(el) {
  if (!el || !el.getBoundingClientRect) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  return true;
}

// Find the visible duplicate dialog. There may be several [role="dialog"]
// elements mounted (notifications, other modals); we want the one that's
// actually rendered AND contains duplicate-related text.
function findDuplicateDialog() {
  const all = [...document.querySelectorAll('[role="dialog"]')].filter(isVisible);
  if (!all.length) return null;
  const markers = ['duplicate', 'שכפל', 'שכפול', 'original campaign', 'existing campaign', 'קמפיין קיים'];
  for (const d of all) {
    const t = (d.innerText || d.textContent || '').toLowerCase();
    if (markers.some(m => t.includes(m))) return d;
  }
  // Fallback: largest visible dialog
  return all.sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return (br.width * br.height) - (ar.width * ar.height);
  })[0];
}

// Find the visible Find & Replace dialog (its title is "Replace text in N ad name").
function findReplaceDialog() {
  const all = [...document.querySelectorAll('[role="dialog"]')].filter(isVisible);
  for (const d of all) {
    const t = (d.innerText || '').toLowerCase();
    if (
      t.includes('replace text in') ||
      t.includes('find and replace') ||
      t.includes('find & replace') ||
      t.includes('חיפוש והחלפה')
    ) {
      return d;
    }
  }
  return null;
}

// Set the value of a React-controlled <input> or <textarea> in a way that
// React's onChange picks up. Direct `el.value = x` doesn't fire React's
// listener because React tracks the previous value on the prototype.
function setReactInputValue(el, value) {
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// Find the deepest visible element whose textContent contains `text`
// (case-insensitive). Optionally restrict to clickable-looking elements.
function findDeepestByText(text, { root = document, clickableOnly = false, exact = false } = {}) {
  const target = text.toLowerCase().trim();
  if (!target) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const matches = [];
  let node = walker.nextNode();
  while (node) {
    const txt = (node.textContent || '').toLowerCase().trim();
    const ownTxt = (node.innerText || txt).toLowerCase().trim();
    if (txt && (exact ? ownTxt === target : txt.includes(target))) {
      if (isVisible(node)) matches.push(node);
    }
    node = walker.nextNode();
  }
  // Sort by depth descending — deepest first
  matches.sort((a, b) => elementDepth(b) - elementDepth(a));

  if (!clickableOnly) return matches[0] || null;

  const clickableTags = new Set(['BUTTON', 'A', 'LABEL', 'INPUT']);
  const clickableRoles = new Set(['button', 'radio', 'checkbox', 'menuitem', 'option', 'tab', 'link', 'switch']);
  for (const m of matches) {
    if (clickableTags.has(m.tagName)) return m;
    const role = m.getAttribute('role');
    if (role && clickableRoles.has(role.toLowerCase())) return m;
    // Also consider elements that have an onClick or are descendants of [role=button]
    if (m.closest('[role="button"], button, [role="radio"], label')) {
      return m.closest('[role="button"], button, [role="radio"], label');
    }
  }
  // Nothing strictly clickable — return deepest match (caller may try to click anyway)
  return matches[0] || null;
}

function findAnyText(textVariants, opts = {}) {
  for (const t of textVariants) {
    const el = findDeepestByText(t, opts);
    if (el) return { el, matched: t };
  }
  return null;
}

// For radio buttons: given the label-text, click the actual <input type="radio">.
function clickRadioByLabel(textVariants, root = document) {
  for (const t of textVariants) {
    const target = t.toLowerCase().trim();
    // Try labels first
    const labels = [...root.querySelectorAll('label')];
    for (const lbl of labels) {
      const txt = (lbl.innerText || lbl.textContent || '').toLowerCase();
      if (!txt.includes(target)) continue;
      const radio = lbl.querySelector('input[type="radio"]')
        || (lbl.htmlFor ? root.querySelector(`#${CSS.escape(lbl.htmlFor)}`) : null);
      if (radio) { clickEl(radio); return { matched: t, via: 'label-radio' }; }
      // No <input>? Click the label itself.
      clickEl(lbl);
      return { matched: t, via: 'label-click' };
    }
    // Fallback: any [role="radio"] near the text
    const all = [...root.querySelectorAll('[role="radio"]')];
    for (const r of all) {
      const ctx = r.closest('label, div, li, [role="radiogroup"]') || r.parentElement;
      const txt = (ctx?.innerText || ctx?.textContent || '').toLowerCase();
      if (txt.includes(target)) { clickEl(r); return { matched: t, via: 'role-radio' }; }
    }
    // Last resort: deepest text match → walk up to find a radio sibling
    const hit = findDeepestByText(t, { root });
    if (hit) {
      const radio = hit.closest('label')?.querySelector('input[type="radio"]')
        || hit.parentElement?.querySelector('input[type="radio"]')
        || hit.closest('[role="radiogroup"]')?.querySelector('[role="radio"]');
      if (radio) { clickEl(radio); return { matched: t, via: 'text-then-radio' }; }
      clickEl(hit);
      return { matched: t, via: 'text-only' };
    }
  }
  return null;
}

// ---------- input ----------

function fireKeyboardShortcut({ key, code, ctrlKey = false, shiftKey = false, altKey = false, metaKey = false }) {
  const opts = {
    key, code, ctrlKey, shiftKey, altKey, metaKey,
    bubbles: true, cancelable: true, composed: true,
    keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
    which: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0
  };
  document.dispatchEvent(new KeyboardEvent('keydown', opts));
  document.dispatchEvent(new KeyboardEvent('keyup', opts));
}

function clickEl(el) {
  if (!el) throw new Error('clickEl: null element');
  el.scrollIntoView({ block: 'center', behavior: 'instant' });

  // Native form inputs (radio, checkbox) need .click() to actually toggle
  // the `checked` state — synthetic 'click' events don't trigger native
  // form behavior. For these we just call .click() and skip the synthetic
  // event sequence (which would not change the state anyway).
  const isFormToggle = el.tagName === 'INPUT' && /^(radio|checkbox)$/i.test(el.type || el.getAttribute('type') || '');
  if (isFormToggle) {
    if (typeof el.click === 'function') el.click();
    return;
  }

  // For non-form clickable elements (buttons, divs with role=button, links),
  // dispatch a full pointer + mouse + click event sequence WITH coordinates.
  // React filters out clicks that lack realistic clientX/clientY, which is
  // why bare .click() failed on FB's div-only "Add to all" button.
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const opts = {
    bubbles: true, cancelable: true, view: window,
    button: 0, buttons: 1,
    clientX: x, clientY: y, screenX: x, screenY: y
  };
  const ptrOpts = { ...opts, pointerType: 'mouse', isPrimary: true };
  try {
    el.dispatchEvent(new PointerEvent('pointerover', ptrOpts));
    el.dispatchEvent(new PointerEvent('pointerenter', ptrOpts));
    el.dispatchEvent(new PointerEvent('pointerdown', ptrOpts));
  } catch (_) { /* PointerEvent unsupported — fall through */ }
  el.dispatchEvent(new MouseEvent('mouseover', opts));
  el.dispatchEvent(new MouseEvent('mouseenter', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  try {
    el.dispatchEvent(new PointerEvent('pointerup', ptrOpts));
  } catch (_) {}
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
}

// Hover without clicking — opens hover-triggered submenus (e.g. Edit ▾ →
// General). Verified live: FB's React listeners accept these synthetic events.
function hoverEl(el) {
  if (!el) throw new Error('hoverEl: null element');
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const opts = {
    bubbles: true, cancelable: true, view: window,
    clientX: x, clientY: y, screenX: x, screenY: y
  };
  const ptrOpts = { ...opts, pointerType: 'mouse', isPrimary: true };
  try {
    el.dispatchEvent(new PointerEvent('pointerover', ptrOpts));
    el.dispatchEvent(new PointerEvent('pointerenter', ptrOpts));
    el.dispatchEvent(new PointerEvent('pointermove', ptrOpts));
  } catch (_) { /* PointerEvent unsupported — fall through */ }
  el.dispatchEvent(new MouseEvent('mouseover', opts));
  el.dispatchEvent(new MouseEvent('mouseenter', opts));
  el.dispatchEvent(new MouseEvent('mousemove', opts));
}

// ---------- localized strings ----------

const STEP_TEXT = {
  duplicate:        ['Duplicate', 'שכפל', 'שכפול'],
  existingCampaign: ['Existing campaign', 'קמפיין קיים'],
  originalCampaign: ['Original campaign', 'הקמפיין המקורי'],
  addToAll:         ['Add to all', 'Apply to all', 'Select all', 'הוסף לכל', 'בחר הכל'],
  findAndReplace:   ['Find and Replace', 'Find & Replace', 'חיפוש והחלפה'],
  apply:            ['Apply', 'החל', 'בצע'],
  edit:             ['Edit', 'עריכה'],
  rename:           ['Rename', 'שנה שם'],
  duplicateOriginalSetup: ['Duplicate original setup', 'שכפל הגדרה מקורית', 'שכפל הגדרות מקוריות'],
  duplicateWithRecommendation: ['Duplicate with recommendation', 'Duplicate with recommendations'],
  continueBtn: ['Continue', 'המשך'],
};

// ---------- steps ----------

// The table toolbar's "Duplicate" button. It's a div[role=button] with the
// same label as the dialog's own primary button, so skip anything in a dialog.
function findToolbarDuplicateButton() {
  const targets = STEP_TEXT.duplicate.map(s => s.toLowerCase());
  return [...document.querySelectorAll('button, [role="button"]')]
    .filter(isVisible)
    .filter(b => !b.closest('[role="dialog"]'))
    .find(b => targets.includes((b.innerText || '').trim().toLowerCase())) || null;
}

async function step_openDuplicateDialog() {
  log('Step 1: open duplicate dialog');
  // Don't re-open if it's already up (the shortcut toggles).
  if (findDuplicateDialog()) {
    log('Dialog already open.');
    return;
  }
  // Verified live (Sep 2026): FB no longer reacts to the synthetic
  // Ctrl+Shift+D — no dialog, even with focus inside the ads table — but
  // clickEl on the toolbar "Duplicate" button opens it. Click the button
  // first; keep the shortcut as a fallback for views without the button.
  const toolbarBtn = findToolbarDuplicateButton();
  if (toolbarBtn) {
    log('Clicking toolbar Duplicate button');
    clickEl(toolbarBtn);
    try {
      await waitFor(findDuplicateDialog, { label: 'duplicate dialog', timeout: 5000 });
      log('Dialog appeared.');
      return;
    } catch (_) {
      log('Toolbar Duplicate click did not open the dialog — trying Ctrl+Shift+D');
    }
  } else {
    log('Toolbar Duplicate button not found — trying Ctrl+Shift+D');
  }
  fireKeyboardShortcut({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true });
  await waitFor(findDuplicateDialog, { label: 'duplicate dialog (are ads selected?)', timeout: 5000 });
  log('Dialog appeared.');
}

// Some ad accounts show an extra "recommendations" prompt BEFORE the real
// config dialog: title "Duplicate your ad", two buttons "Duplicate original
// setup" / "Duplicate with recommendation". Click "Duplicate original setup"
// to skip recommendations and advance to the real dialog.
async function step_dismissRecommendationsPrompt() {
  log('Step 1.5: dismiss recommendations pre-dialog if present');
  const dialog = findDuplicateDialog();
  if (!dialog) return;
  const text = (dialog.innerText || '').toLowerCase();

  const lookFor = STEP_TEXT.duplicateOriginalSetup.map(s => s.toLowerCase());
  const isRecommendationsDialog = lookFor.some(v => text.includes(v));
  if (!isRecommendationsDialog) {
    log('No recommendations pre-dialog; skipping.');
    return;
  }

  const buttons = [...dialog.querySelectorAll('button, [role="button"]')].filter(isVisible);
  let btn = null;
  for (const v of STEP_TEXT.duplicateOriginalSetup) {
    const target = v.toLowerCase().trim();
    btn = buttons.find(b => (b.innerText || '').trim().toLowerCase() === target);
    if (btn) break;
  }
  if (!btn) {
    for (const v of STEP_TEXT.duplicateOriginalSetup) {
      const target = v.toLowerCase().trim();
      btn = buttons.find(b => (b.innerText || '').toLowerCase().includes(target));
      if (btn) break;
    }
  }
  if (!btn) {
    log('Recommendations dialog detected but "Duplicate original setup" button not found.');
    return;
  }
  clickEl(btn);
  log('Clicked Duplicate original setup; waiting for config dialog…');

  // Wait for the actual config dialog (which has the Existing/Original/New
  // campaign radios). Either it replaces the current dialog or a fresh one
  // appears.
  await waitFor(
    () => {
      const d = findDuplicateDialog();
      if (!d) return false;
      const t = (d.innerText || '').toLowerCase();
      return /existing campaign|original campaign|קמפיין קיים|הקמפיין המקורי/i.test(t);
    },
    { label: 'config dialog after recommendations', timeout: 6000 }
  );
}

// Steps 1.5 and 1.6 each look at the dialog once and skip themselves if it
// isn't on their screen, so they must not look while it's still rendering.
// Wait until it shows one of the screens we know how to drive.
async function waitForKnownDuplicateScreen() {
  try {
    await waitFor(() => {
      const d = findDuplicateDialog();
      if (!d) return false;
      const t = (d.innerText || '').toLowerCase();
      return STEP_TEXT.duplicateOriginalSetup.some(v => t.includes(v.toLowerCase()))
        || /existing campaign|original campaign|קמפיין קיים|הקמפיין המקורי/i.test(t)
        || isRecommendationsCheckboxScreen(d);
    }, { label: 'duplicate dialog screen', timeout: 8000 });
  } catch (_) {
    // Let the following steps fail with their own, more specific errors.
    const d = findDuplicateDialog();
    log('Dialog is not on a known screen: ' + (d ? (d.innerText || '').replace(/\s+/g, ' ').slice(0, 300) : '(no dialog)'));
  }
}

// Newer accounts show a checkbox screen BEFORE the real config dialog:
// title "Duplicate your ad(s)", a bold header with checkboxes (SMS
// Verification / Advantage+ creative / Add music to Reels / etc.), and a
// primary button. FB rewords this screen: it used to say "Apply
// recommendation(s)"; since Sep 2026 it says "Applying this recommendation
// could improve performance…" / "Select recommendation". So match its shape
// rather than a phrase: a visible checkbox, the word "recommendation", and
// no campaign picker yet.
function isRecommendationsCheckboxScreen(dialog) {
  const text = dialog.innerText || '';
  return /recommendation|המלצ/i.test(text) &&
    !/existing campaign|original campaign|קמפיין קיים|הקמפיין המקורי/i.test(text) &&
    [...dialog.querySelectorAll('input[type="checkbox"]')].some(isVisible);
}

// Verified live: leaving any checkbox checked makes the button read
// "Duplicate" and clicking it duplicates in place immediately — it SKIPS the
// campaign/ad-set picker entirely. Unchecking every box flips the button to
// "Continue", which advances to the real Existing/Original/New campaign
// picker that step_chooseExistingCampaign expects (re-verified Sep 2026).
// So we must uncheck everything to reach the ad-set-moving flow.
async function step_dismissApplyRecommendationsCheckboxes() {
  log('Step 1.6: uncheck recommendation upsells if present');
  const dialog = findDuplicateDialog();
  if (!dialog) return;
  if (!isRecommendationsCheckboxScreen(dialog)) {
    log('No recommendations checkbox screen; skipping.');
    return;
  }

  // Uncheck every checked box. A master checkbox may cascade-uncheck its
  // children in one click, so re-query after each click rather than
  // collecting a stale list up front.
  for (let i = 0; i < 8; i++) {
    const boxes = [...dialog.querySelectorAll('input[type="checkbox"]')].filter(isVisible);
    const checked = boxes.filter(b => b.checked);
    if (!checked.length) break;
    clickEl(checked[0]);
    await new Promise(r => setTimeout(r, 200));
  }
  const stillChecked = [...dialog.querySelectorAll('input[type="checkbox"]')].filter(isVisible).filter(b => b.checked);
  if (stillChecked.length) {
    throw new Error(`Could not uncheck ${stillChecked.length} recommendation checkbox(es) after 8 attempts — aborting before clicking through, since leaving them checked would make FB skip the ad-set picker entirely.`);
  }

  // Click the primary action button — prefer "Continue" (the long path to
  // the ad-set picker); fall back to "Duplicate" with a warning, since with
  // every checkbox unchecked that fallback should be rare.
  const buttons = [...dialog.querySelectorAll('button, [role="button"]')]
    .filter(isVisible)
    .filter(b => {
      const t = (b.innerText || '').trim();
      return t && t.length < 30;
    });
  let btn = null;
  for (const t of STEP_TEXT.continueBtn) {
    const target = t.toLowerCase().trim();
    btn = buttons.find(b => (b.innerText || '').trim().toLowerCase() === target);
    if (btn) break;
  }
  if (!btn) {
    for (const t of STEP_TEXT.duplicate) {
      const target = t.toLowerCase().trim();
      btn = buttons.find(b => (b.innerText || '').trim().toLowerCase() === target);
      if (btn) break;
    }
    if (btn) log('Warning: only found a "Duplicate"-labeled button with all checkboxes unchecked — the ad-set picker may be skipped.');
  }
  if (!btn) throw new Error('Could not find Continue/Duplicate button on recommendations screen.');
  log('Clicking primary button on recommendations screen: ' + (btn.innerText || '').trim());
  clickEl(btn);

  // Wait for the campaign-picker screen. FB unmounts this dialog and mounts
  // the picker as a separate one, leaving a brief gap where no duplicate
  // dialog is visible (verified live Sep 2026) — so a missing dialog right
  // after the click is NOT proof that FB completed the short-path duplicate.
  // Only conclude that if no dialog ever comes back.
  try {
    await waitFor(() => {
      const d = findDuplicateDialog();
      return d && /existing campaign|original campaign|קמפיין קיים|הקמפיין המקורי/i.test(d.innerText || '');
    }, { label: 'campaign picker after recommendations screen', timeout: 10000 });
  } catch (e) {
    if (!findDuplicateDialog()) {
      throw new Error('Dialog closed right after the recommendations screen — FB likely completed a same-ad-set duplicate without the campaign/ad-set picker. Check your drafts before retrying.');
    }
    throw e;
  }
}

async function step_chooseExistingCampaign() {
  log('Step 2: choose Existing campaign radio');
  const dialog = await waitFor(findDuplicateDialog, { label: 'duplicate dialog' });

  // Retry the click — the dialog can render with 0 labels for ~500ms during
  // hydration, in which case clickRadioByLabel returns null on the first try.
  let result = null;
  for (let i = 0; i < 15 && !result; i++) {
    try {
      result = clickRadioByLabel(STEP_TEXT.existingCampaign, dialog);
    } catch (e) {
      log('Step 2: clickRadioByLabel threw: ' + e.message);
    }
    if (!result) await new Promise(r => setTimeout(r, 250));
  }
  if (!result) {
    // Include what the dialog shows instead, so the next time FB inserts a
    // new screen the popup error names it.
    const d = findDuplicateDialog();
    const shows = d ? (d.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200) : '(no dialog)';
    throw new Error(`Could not click "Existing campaign" radio after 15 attempts. Dialog shows: ${shows}`);
  }
  log('Clicked Existing campaign via: ' + result.via);
}

async function step_clickDuplicateButton() {
  log('Step 5: click Duplicate button');
  const dialog = await waitFor(findDuplicateDialog, { label: 'duplicate dialog' });
  // Avoid the dialog title which contains "Duplicate your ad" — search buttons only,
  // and exclude the dialog header area (title region).
  const buttons = [...dialog.querySelectorAll('button, [role="button"]')]
    .filter(isVisible)
    .filter(b => {
      const t = (b.innerText || b.textContent || '').trim();
      // Must be short enough to be a button label, not the title.
      return t && t.length < 30;
    });
  let btn = null;
  for (const t of STEP_TEXT.duplicate) {
    const target = t.toLowerCase().trim();
    btn = buttons.find(b => (b.innerText || b.textContent || '').trim().toLowerCase() === target);
    if (btn) break;
  }
  if (!btn) {
    for (const t of STEP_TEXT.duplicate) {
      const target = t.toLowerCase().trim();
      btn = buttons.find(b => (b.innerText || b.textContent || '').toLowerCase().includes(target));
      if (btn) break;
    }
  }
  if (!btn) throw new Error('Could not find the final "Duplicate" button.');
  clickEl(btn);
}

// Identify CHIP close buttons (the X next to a selected ad set chip).
// Verified against live FB Ads Manager via browser automation:
//   - The "Close" text inside a chip is a screen-reader-only SPAN.
//   - The actual clickable is a <button> sibling that holds the X icon.
//   - Clicking the SR-only SPAN does nothing; we must click the <button>.
function findChipCloseButtons(dialog) {
  const candidates = new Set();

  // Strategy 1: aria-label match
  const ariaSel = '[aria-label="Close" i], [aria-label*="Remove" i], [aria-label*="הסר" i], [aria-label*="סגור" i]';
  for (const el of dialog.querySelectorAll(ariaSel)) {
    if (isVisible(el)) candidates.add(el);
  }

  // Strategy 2: exact text "Close" / "סגור" / "הסר" on a small element
  const closeWords = new Set(['close', 'סגור', 'הסר', 'remove', '×', '✕']);
  const textSearch = dialog.querySelectorAll('span, a, button, div, [role="button"]');
  for (const el of textSearch) {
    if (!isVisible(el)) continue;
    const t = (el.innerText || el.textContent || '').trim().toLowerCase();
    if (t && closeWords.has(t)) candidates.add(el);
  }

  const out = [];
  const seenNames = new Set();
  for (const candidate of candidates) {
    const result = chipForCloseCandidate(candidate, dialog);
    if (!result) continue;
    if (seenNames.has(result.name)) continue;
    seenNames.add(result.name);
    out.push({ btn: result.clickable, name: result.name, chipEl: result.chipEl });
  }
  return out;
}

// Walk up from a close-candidate to find the chip container, and return both
// the chip element AND the actual clickable <button> inside it. The clickable
// is the chip's real X button (not the SR-only "Close" text).
function chipForCloseCandidate(candidate, dialog) {
  let p = candidate.parentElement;
  for (let i = 0; i < 6 && p && p !== dialog; i++) {
    const txt = (p.innerText || '').trim();
    // Reject parents that are clearly the dialog header / content area.
    if (
      /duplicate your ad/i.test(txt) ||
      /select a campaign for your ad/i.test(txt) ||
      /select an ad set for your ad/i.test(txt) ||
      txt.length > 200
    ) {
      p = p.parentElement;
      continue;
    }
    if (txt.length > 0) {
      const name = txt
        .replace(/\bClose\b/gi, '')
        .replace(/\bRemove\b/gi, '')
        .replace(/סגור/g, '')
        .replace(/הסר/g, '')
        .replace(/[×✕]/g, '')
        .replace(/[​-‏‪-‮⁠﻿]/g, '')  // strip zero-width chars
        .replace(/\s+/g, ' ')
        .trim();
      const visibleChars = name.replace(/\s/g, '');
      if (
        visibleChars.length >= 2 &&
        name.length < 100 &&
        !/^(close|remove|cancel|duplicate|add to all|remove all|select all)$/i.test(name) &&
        !/^(remove all|add to all)/i.test(name)
      ) {
        // Found a valid chip parent. Now find the real clickable inside it.
        const clickable = p.querySelector('button')
          || p.querySelector('[role="button"]')
          || candidate;
        return { name, chipEl: p, clickable };
      }
    }
    p = p.parentElement;
  }
  return null;
}

// Click the close X on a chip whose name matches `name`. Always re-queries
// the live DOM (chip elements are unstable after "Add to all" re-renders).
function removeChipByName(dialog, name) {
  const chips = findChipCloseButtons(dialog);
  const hit = chips.find(c => c.name === name);
  if (!hit) return false;
  clickEl(hit.btn);
  return true;
}

async function step_addToAll(state) {
  log('Step 3: capture source ad set name(s), then click Add to all');
  const dialog = await waitFor(findDuplicateDialog, { label: 'duplicate dialog' });

  // Snapshot only the NAMES of pre-selected chips. References go stale after
  // Add to all re-renders the chip list, so we'll re-find by name.
  const initial = findChipCloseButtons(dialog);
  state.sourceNames = initial.map(c => c.name);
  log(`BEFORE Add to all — chips: ${initial.length}`, state.sourceNames);

  if (!state.sourceNames.length) {
    log('Warning: no chips detected before Add to all. Source removal will be skipped.');
  }

  // Find and click "Add to all"
  let target = null;
  let matched = null;
  for (const t of STEP_TEXT.addToAll) {
    const hit = findDeepestByText(t, { root: dialog, clickableOnly: true });
    if (hit) { target = hit; matched = t; break; }
  }
  if (!target) {
    const buttons = [...dialog.querySelectorAll('button, [role="button"], a')].filter(isVisible);
    for (const t of STEP_TEXT.addToAll) {
      const hit = buttons.find(b => (b.innerText || '').trim().toLowerCase() === t.toLowerCase());
      if (hit) { target = hit; matched = t; break; }
    }
  }
  if (!target) throw new Error('Could not find "Add to all" button.');
  log('Clicking Add to all — matched text:', matched, 'tag:', target.tagName, 'role:', target.getAttribute('role'));
  clickEl(target);

  // Wait for the chip count to grow (proof the click took effect).
  try {
    await waitFor(() => {
      const d = findDuplicateDialog();
      if (!d) return false;
      const count = findChipCloseButtons(d).length;
      return count > initial.length;
    }, { label: 'chips to expand after Add to all', timeout: 4000 });
    const after = findChipCloseButtons(findDuplicateDialog()).length;
    log(`AFTER Add to all — chips: ${after}`);
  } catch (e) {
    const after = findChipCloseButtons(findDuplicateDialog()).length;
    log(`AFTER Add to all — chips DID NOT GROW. count=${after}. The button may have been the wrong element.`);
    throw new Error(`"Add to all" click did not expand the selection (still ${after} chip${after === 1 ? '' : 's'}). Wrong button or click was a no-op.`);
  }
}

async function step_removeSourceAdsetChip(state) {
  log('Step 4: remove source ad set chip(s) by name');
  if (!state.sourceNames || !state.sourceNames.length) {
    log('No source names captured — skipping removal.');
    return;
  }
  for (const name of state.sourceNames) {
    const dialog = findDuplicateDialog();
    if (!dialog) {
      log('Dialog disappeared mid-removal — aborting removal step.');
      return;
    }
    const removed = removeChipByName(dialog, name);
    log(removed ? `Removed chip: ${name}` : `Could not find chip to remove: ${name}`);
    await new Promise(r => setTimeout(r, 300));
  }
  const finalCount = findChipCloseButtons(findDuplicateDialog()).length;
  log(`AFTER source removal — chips: ${finalCount}`);
  if (finalCount === 0) {
    throw new Error('All chips were removed — the dialog has no targets. Aborting before Duplicate.');
  }
}

// Open the post-duplicate "Edit" dropdown menu and click "Find and replace".
// Verified live: the menu lazy-loads (~1-3s), then the F&R dialog opens.
async function step_openFindAndReplaceFromEditMenu() {
  log('Step 6: open Edit dropdown and click Find and replace');

  // Find the Edit menu dropdown (role=button + aria-haspopup=menu). Only the
  // table view has it — the /edit/standalone view's lone "Action Menu" has no
  // Find and replace (see isStandaloneEditView), so callers navigate first.
  const findMenuTrigger = () => {
    const candidates = [...document.querySelectorAll('[role="button"][aria-haspopup="menu"]')]
      .filter(isVisible);
    // Preference order: "Edit", "Action Menu", anything else
    return candidates.find(b => /^edit\b/i.test((b.innerText || '').trim()))
      || candidates.find(b => /action\s*menu/i.test((b.innerText || '').trim()))
      || candidates.find(b => /more|⋯|\.\.\./.test((b.innerText || '').trim()))
      || candidates[0]
      || null;
  };
  const editBtn = await waitFor(findMenuTrigger,
    { label: 'Edit/Action menu trigger', timeout: 15000 });
  log('Found menu trigger: ' + (editBtn.innerText || '').trim().slice(0, 30));
  clickEl(editBtn);

  // Since Sep 2026 the Edit menu is a list of hover submenus (General /
  // Identity / Creative / Tracking) and Find and replace sits under General,
  // next to Turn off / Turn on. Older layouts had it at the top level, so
  // accept either.
  const FNR_EXACT = /^find\s*(and|&)\s*replace$|^חיפוש\s*והחלפה$/i;
  const visibleMenus = () => [...document.querySelectorAll('[role="menu"]')].filter(isVisible);
  const menuWithFindReplace = () => visibleMenus()
    .find(m => /find\s*(and|&)\s*replace|חיפוש\s*והחלפה/i.test(m.innerText || ''));
  // Top-level entries are role=button (submenu triggers). General first —
  // that's where F&R lives — the rest only in case FB moves it again.
  const submenuTriggers = (m) => {
    const items = [...m.querySelectorAll('[role="button"], [role="menuitem"]')]
      .filter(isVisible)
      .filter(el => (el.innerText || '').trim());
    const isGeneral = el => /^general$|^כללי$/i.test((el.innerText || '').trim());
    return [...items.filter(isGeneral), ...items.filter(el => !isGeneral(el))];
  };

  // The menu lazy-loads — wait for menu items to appear (not just "Loading...").
  // Some accounts take 10+ seconds, especially right after a duplicate
  // operation when FB is busy hydrating the drafts panel.
  const menu = await waitFor(() => {
    const direct = menuWithFindReplace();
    if (direct) return direct;
    const m = visibleMenus()[0];
    if (!m) return null;
    if (/loading\b/i.test(m.innerText || '')) return null;
    return submenuTriggers(m).length ? m : null;
  }, { label: 'Edit menu populated', timeout: 20000 });

  let fnrMenu = menuWithFindReplace();
  if (!fnrMenu) {
    for (const trigger of submenuTriggers(menu)) {
      log('Hovering Edit submenu: ' + (trigger.innerText || '').trim());
      hoverEl(trigger);
      fnrMenu = await waitFor(menuWithFindReplace, { label: 'F&R submenu', timeout: 2500 })
        .catch(() => null);
      if (fnrMenu) break;
    }
  }
  if (!fnrMenu) throw new Error('Could not find "Find and replace" in the Edit menu or its submenus.');

  // Click the exact "Find and replace" item — the submenu also holds
  // Turn off / Turn on, so never fall back to a loose match. Prefer the
  // role=menuitem; otherwise the deepest visible element with that text.
  const isFnR = el => FNR_EXACT.test((el.innerText || '').trim());
  const target = [...fnrMenu.querySelectorAll('[role="menuitem"]')].filter(isVisible).find(isFnR)
    || [...fnrMenu.querySelectorAll('*')].filter(isVisible).filter(isFnR)
      .sort((a, b) => elementDepth(b) - elementDepth(a))[0];
  if (!target) throw new Error('Could not find "Find and replace" in the Edit menu.');
  clickEl(target);

  // Wait for the F&R dialog to render.
  await waitFor(findReplaceDialog, { label: 'find & replace dialog', timeout: 5000 });
}

// Run the Find & Replace dialog: fill " - Copy" on the Find field, then
// click Save to draft as soon as it becomes enabled.
//
// Verified pattern (live browser test): after execCommand('insertText'),
// the Save button becomes enabled within ~100ms. If we wait too long,
// React reverts the value and Save goes back to disabled. So this code
// fills then polls in 100ms ticks for an enabled Save button, clicking
// the moment it's available.
async function step_applyFindAndReplace() {
  log('Step: apply Find & Replace " - Copy" → ""');

  // Re-find dialog/inputs/button on every poll — React replaces nodes
  // during re-renders, so any reference captured before a render will
  // be detached. ALL lookups happen via these helpers.
  const getDialog = () => findReplaceDialog();
  // FB has been migrating from <input> to contenteditable (Lexical) editors,
  // so we accept either. Order matters: we want the Find field FIRST, so we
  // preserve DOM order from the dialog.
  const getInputs = () => {
    const d = getDialog();
    if (!d) return [];
    return [...d.querySelectorAll(
      'input[type="text"], input[type="search"], input:not([type]), textarea, ' +
      '[contenteditable="true"], [role="textbox"]'
    )].filter(isVisible);
  };
  const fillField = (el, text) => {
    el.focus();
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.select();
    } else {
      // contenteditable / role=textbox — select all existing content so
      // insertText replaces it instead of appending.
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    document.execCommand('insertText', false, text);
  };
  const getSaveBtn = () => {
    const d = getDialog();
    if (!d) return null;
    const buttons = [...d.querySelectorAll('button, [role="button"]')]
      .filter(isVisible)
      .filter(b => {
        const t = (b.innerText || '').trim();
        return t && t.length < 30;
      });
    const candidates = ['save to draft', 'save', 'apply', 'שמור כטיוטה', 'שמור', 'החל'];
    for (const c of candidates) {
      const hit = buttons.find(b => (b.innerText || '').trim().toLowerCase() === c);
      if (hit) return hit;
    }
    return buttons.find(b => /save\s*to\s*draft|save\s*as\s*draft|שמור/i.test(b.innerText || '')) || null;
  };
  const isDisabled = (btn) => !btn || btn.disabled
    || btn.getAttribute('aria-disabled') === 'true'
    || btn.getAttribute('disabled') !== null;

  // Wait for inputs to appear. Fresh dialog usually mounts in ~200ms, but
  // slow accounts can take several seconds — Lexical editors in particular
  // hydrate lazily. On timeout, dump dialog state so the next failure points
  // to the real issue (wrong dialog matched? missing inputs? loading state?).
  try {
    await waitFor(() => getInputs().length >= 2, {
      label: 'F&R inputs',
      timeout: 12000
    });
  } catch (e) {
    const d = getDialog();
    const snapshot = {
      dialogFound: !!d,
      dialogTitle: d ? (d.innerText || '').split('\n').slice(0, 3).join(' | ').slice(0, 200) : null,
      inputCount: getInputs().length,
      rawInputs: d ? [...d.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]')]
        .map(el => ({
          tag: el.tagName,
          type: el.getAttribute('type'),
          role: el.getAttribute('role'),
          ariaLabel: el.getAttribute('aria-label'),
          contenteditable: el.getAttribute('contenteditable'),
          visible: isVisible(el)
        })).slice(0, 10) : [],
      visibleDialogs: [...document.querySelectorAll('[role="dialog"]')]
        .filter(isVisible)
        .map(x => (x.innerText || '').split('\n')[0].slice(0, 80))
    };
    log('F&R inputs not found — snapshot: ' + JSON.stringify(snapshot));
    throw new Error('Find & Replace inputs not found. Diagnostic: ' + JSON.stringify(snapshot).slice(0, 400));
  }
  log(`F&R inputs found: ${getInputs().length}`);

  // Outer loop — up to 5 fill+save cycles. If Save stays disabled for too
  // long after a fill (React reverted), we re-fill and try again.
  let saved = false;
  for (let attempt = 0; attempt < 5 && !saved; attempt++) {
    const inputs = getInputs();
    const findInput = inputs[0];
    if (!findInput) {
      await new Promise(r => setTimeout(r, 200));
      continue;
    }
    fillField(findInput, ' - Copy');

    // Tight poll (100ms ticks, 2s budget) for an enabled Save button.
    // Click the moment we see it, before React can revert the value.
    let clickedBtn = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 100));
      const btn = getSaveBtn();
      if (btn && !isDisabled(btn)) { clickedBtn = btn; break; }
    }
    if (clickedBtn) {
      log(`F&R fill+click succeeded on attempt ${attempt + 1}`);
      clickEl(clickedBtn);
      // Verify dialog closed.
      await new Promise(r => setTimeout(r, 800));
      if (!getDialog()) { saved = true; break; }
      log('Dialog still open after Save click — retrying');
    } else {
      log(`F&R attempt ${attempt + 1}: Save never became enabled`);
    }
  }
  if (!saved) {
    throw new Error('Find & Replace did not save after 5 attempts.');
  }
}

// ---------- orchestrator ----------
//
// v1 strategy: do step 1 (open dialog) and step 2 (click Existing campaign)
// only — then STOP and let the user finish the rest manually. This proves
// out the basic clicking mechanism before we tackle the campaign picker
// and ad-set selection (each of which is its own dynamic UI section).

async function runFullFlow() {
  const state = {};
  await step_openDuplicateDialog();
  await waitForKnownDuplicateScreen();
  await new Promise(r => setTimeout(r, 600));
  await step_dismissRecommendationsPrompt();
  await new Promise(r => setTimeout(r, 400));
  await step_dismissApplyRecommendationsCheckboxes();
  await new Promise(r => setTimeout(r, 400));
  await step_chooseExistingCampaign();
  await new Promise(r => setTimeout(r, 800));  // wait for ad-set section to render
  await step_addToAll(state);
  await new Promise(r => setTimeout(r, 500));
  await step_removeSourceAdsetChip(state);
  await new Promise(r => setTimeout(r, 400));

  // Set a "pending cleanup" flag JUST BEFORE clicking Duplicate. After the
  // click, FB navigates the page (e.g. /manage/ads → /manage/ads/edit/standalone)
  // which destroys this content script context. The freshly-loaded content
  // script on the new page reads this flag in its onLoad handler and runs
  // the F&R cleanup automatically — that's how we span the navigation.
  await chrome.storage.local.set({ pendingFnRCleanup: { setAt: Date.now() } });
  log('Set pendingFnRCleanup flag — handing off to next page context');

  // Snapshot URL state BEFORE clicking Duplicate. We use the change in the
  // selected_ad_ids list as the signal that the duplication actually completed
  // (FB updates the URL to point to the newly-created drafts). This is far
  // more reliable than checking for "Discard drafts" / "Review and publish"
  // buttons which may already be visible from prior drafts.
  const getSelectedIdSet = () => {
    const raw = new URLSearchParams(location.search).get('selected_ad_ids') || '';
    return new Set(raw ? raw.split(',') : []);
  };
  const beforeIds = getSelectedIdSet();
  log(`Before Duplicate: ${beforeIds.size} selected ad IDs in URL`);

  await step_clickDuplicateButton();

  // Wait for selected_ad_ids in URL to change to a NEW set (different IDs).
  // FB's duplicate operation: a) updates URL to selected_ad_ids=<new IDs>,
  // b) navigates to /edit/standalone (sometimes). Either way the URL changes.
  log('Step 5.5: wait for URL to reflect new draft IDs');
  try {
    await waitFor(() => {
      const nowIds = getSelectedIdSet();
      if (!nowIds.size) return false;
      // Must contain at least one ID that wasn't in the original selection.
      for (const id of nowIds) if (!beforeIds.has(id)) return true;
      return false;
    }, { label: 'new draft IDs in URL', timeout: 30000, interval: 400 });
    const after = getSelectedIdSet();
    log(`URL updated: ${after.size} draft IDs detected`);
  } catch (e) {
    log('Timed out waiting for URL update — trying F&R anyway');
  }

  // FB navigates to /edit/standalone after Duplicate, and that view does
  // NOT have the Edit ▾ menu (only the table view does). Navigate back to
  // the table view; the page reload re-injects content.js, and
  // checkPendingCleanupOnLoad will see the still-set pendingFnRCleanup
  // flag and run runFnRCleanup() on the new page.
  if (isStandaloneEditView()) {
    log('On /edit/standalone — navigating to the table view for F&R access');
    location.href = tableViewUrl();
    // Page is about to reload. Return now; the rest happens via the
    // post-load handler on the next page.
    return {
      ok: true,
      finishedAt: 'navigating-for-cleanup',
      note: 'Duplicates created. Navigating to table view to apply Find & Replace…'
    };
  }

  // We're already on the table view (or somewhere with the Edit menu).
  // Wait briefly for the drafts panel to hydrate, then run F&R.
  await new Promise(r => setTimeout(r, 3000));

  try {
    await runFnRCleanup();
    await chrome.storage.local.remove('pendingFnRCleanup');
    return {
      ok: true,
      finishedAt: 'find-and-replace-applied',
      note: 'All done — duplicates created and "- Copy" stripped. Review and Publish when ready.'
    };
  } catch (e) {
    log('F&R cleanup threw: ' + e.message);
    return {
      ok: true,
      finishedAt: 'duplicate-clicked',
      note: 'Duplicate succeeded; cleanup failed: ' + e.message + '. With the duplicated drafts still selected, click "Strip - Copy only" — it will open Find and replace and strip " - Copy" itself.'
    };
  }
}

// The bulk-edit view FB opens after Duplicate (/manage/ads/edit/standalone)
// has no Edit ▾ menu. Its only menu is "Action Menu" (Duplicate / Copy /
// Paste / Delete / Create rule), with no Find and replace (verified live Oct
// 2026). The table view at the same URL minus /edit/standalone keeps the
// selection via selected_ad_ids and has the menu.
function isStandaloneEditView() {
  return /\/edit\/standalone\/?$/.test(location.pathname);
}

function tableViewUrl() {
  const u = new URL(location.href);
  u.pathname = u.pathname.replace(/\/edit\/standalone\/?$/, '');
  return u.href;
}

async function runFnRCleanup() {
  await step_openFindAndReplaceFromEditMenu();
  await new Promise(r => setTimeout(r, 400));
  await step_applyFindAndReplace();
}

// On every Ads Manager page load, check the storage flag set right before
// the Duplicate click. If set, the duplicate happened just before this
// page loaded — auto-run the F&R cleanup.
async function checkPendingCleanupOnLoad() {
  try {
    const r = await chrome.storage.local.get(['pendingFnRCleanup']);
    const flag = r.pendingFnRCleanup;
    if (!flag) return;
    // Stale flag — older than 60s, give up to avoid surprising the user
    // on an unrelated future page load.
    if (Date.now() - (flag.setAt || 0) > 60000) {
      await chrome.storage.local.remove('pendingFnRCleanup');
      return;
    }
    log('Pending F&R cleanup detected on page load — running');
    await chrome.storage.local.remove('pendingFnRCleanup');
    // Give the new page time to fully render the toolbar and chip selection.
    await new Promise(r => setTimeout(r, 2000));
    await runFnRCleanup();
    log('Auto F&R cleanup completed');
  } catch (e) {
    log('Auto F&R cleanup failed: ' + e.message);
  }
}
checkPendingCleanupOnLoad();

// ---------- diagnostics ----------

function diagnoseDialog() {
  const allDialogs = [...document.querySelectorAll('[role="dialog"]')];
  const dialog = findDuplicateDialog();
  if (!dialog) {
    return {
      error: 'No duplicate dialog found',
      totalDialogs: allDialogs.length,
      dialogPreviews: allDialogs.slice(0, 5).map(d => ({
        visible: isVisible(d),
        text: (d.innerText || '').slice(0, 120)
      }))
    };
  }
  const radios = [...dialog.querySelectorAll('input[type="radio"], [role="radio"]')]
    .map(r => ({
      tag: r.tagName,
      role: r.getAttribute('role'),
      ariaLabel: r.getAttribute('aria-label'),
      ariaChecked: r.getAttribute('aria-checked'),
      checked: r.checked,
      labelText: (r.closest('label')?.innerText || r.parentElement?.innerText || '').slice(0, 100)
    }));
  const checkboxes = [...dialog.querySelectorAll('input[type="checkbox"], [role="checkbox"]')]
    .filter(isVisible)
    .map(c => ({
      tag: c.tagName,
      role: c.getAttribute('role'),
      ariaChecked: c.getAttribute('aria-checked'),
      checked: c.checked,
      labelText: (c.closest('label')?.innerText || c.parentElement?.innerText || '').slice(0, 100)
    }));
  const chipsFound = findChipCloseButtons(dialog).map(c => c.name);

  // Dump every plausible close-button candidate so we can hand-tune selectors.
  const closeCandidates = [...dialog.querySelectorAll('[aria-label], button, [role="button"], span, a')]
    .filter(isVisible)
    .filter(el => {
      const t = (el.innerText || el.textContent || '').trim().toLowerCase();
      const a = (el.getAttribute('aria-label') || '').toLowerCase();
      return /close|remove|סגור|הסר|×|✕/.test(t) || /close|remove|סגור|הסר/.test(a);
    })
    .slice(0, 25)
    .map(el => ({
      tag: el.tagName,
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      ownText: (el.innerText || '').slice(0, 50),
      parentText:        (el.parentElement?.innerText || '').slice(0, 120),
      grandparentText:   (el.parentElement?.parentElement?.innerText || '').slice(0, 120),
      ggparentText:      (el.parentElement?.parentElement?.parentElement?.innerText || '').slice(0, 120)
    }));

  return {
    totalDialogs: allDialogs.length,
    chosenDialogText: (dialog.innerText || '').slice(0, 1500),
    radios,
    checkboxes,
    chipCloseButtons: chipsFound,
    closeCandidates
  };
}

// ---------- message handling ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'ping') {
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'diagnose') {
    sendResponse({ ok: true, result: diagnoseDialog() });
    return;
  }
  if (msg.type === 'runUiDuplicate') {
    runFullFlow()
      .then(result => {
        log('runFullFlow returned: ' + JSON.stringify(result));
        sendResponse({ ok: true, result });
      })
      .catch(err => {
        log('runFullFlow THREW: ' + err.message);
        sendResponse({ ok: false, error: err.message, stack: err.stack });
      });
    return true;
  }
  if (msg.type === 'applyFindReplace') {
    // "Strip - Copy only" fallback. The F&R dialog may or may not already be
    // open: the user might have opened it manually, or (more often) they just
    // click this button expecting it to do everything. If it's not open, open
    // it ourselves via the same Edit ▾ → Find and replace path the auto flow
    // uses — otherwise step_applyFindAndReplace finds no dialog and fails with
    // "inputs not found / visibleDialogs:[]".
    (async () => {
      if (!findReplaceDialog() && isStandaloneEditView()) {
        // No Find and replace on this view. Same handoff as runFullFlow: set
        // the flag and reload into the table view, where
        // checkPendingCleanupOnLoad runs the cleanup.
        await chrome.storage.local.set({ pendingFnRCleanup: { setAt: Date.now() } });
        log('Strip - Copy on /edit/standalone — navigating to the table view');
        location.href = tableViewUrl();
        return { navigating: true };
      }
      if (!findReplaceDialog()) {
        await step_openFindAndReplaceFromEditMenu();
        await new Promise(r => setTimeout(r, 400));
      }
      await step_applyFindAndReplace();
      return {};
    })()
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err => sendResponse({ ok: false, error: err.message, stack: err.stack }));
    return true;
  }
  if (msg.type === 'togglePanels') {
    togglePanels()
      .then(result => sendResponse({ ok: true, result }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'insertTodayDate') {
    try {
      const result = insertTodayDate();
      sendResponse({ ok: true, result });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return;
  }
});

function todayYmd() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Insert today's date (yyyy-mm-dd) at the cursor of the focused field.
// Handles <input>/<textarea> (with React-friendly setter) and contenteditable.
function insertTodayDate() {
  const date = todayYmd();
  const el = document.activeElement;
  if (!el) {
    log('insertTodayDate: no focused element');
    return { inserted: false, reason: 'no-focus' };
  }

  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + date + el.value.slice(end);
    setReactInputValue(el, next);
    const caret = start + date.length;
    try { el.setSelectionRange(caret, caret); } catch (_) {}
    return { inserted: true, date, target: tag.toLowerCase() };
  }

  if (el.isContentEditable) {
    el.focus();
    const ok = document.execCommand('insertText', false, date);
    return { inserted: ok, date, target: 'contenteditable' };
  }

  log(`insertTodayDate: focused element <${tag.toLowerCase()}> is not editable`);
  return { inserted: false, reason: 'not-editable', tag: tag.toLowerCase() };
}

// Toggle FB's panel-collapse buttons. Identified by aria-label rather than
// position because position-based matching kept hitting the wrong buttons
// (Meta nav icons, including the All Tools opener which is what was being
// triggered before). FB labels these explicitly: "Collapse view" / "Expand
// view" or similar.
async function togglePanels() {
  const isVis = el => {
    if (!el?.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  };

  const candidates = [...document.querySelectorAll('[aria-label]')]
    .filter(isVis)
    .filter(el => {
      const a = (el.getAttribute('aria-label') || '').toLowerCase();
      // Match panel collapse/expand labels. AVOID "show how to improve" etc.
      return /^(collapse|expand)\s+view$/i.test(a)
          || /^(collapse|expand)\s+(side\s*)?panel$/i.test(a)
          || /^(collapse|expand)\s+(left|right|side|nav|sidebar|tree)\b/i.test(a);
    });

  log(`togglePanels: found ${candidates.length} collapse/expand buttons`);
  for (const el of candidates) {
    const aria = el.getAttribute('aria-label');
    log(`Clicking panel button: "${aria}"`);
    clickEl(el);
    await new Promise(r => setTimeout(r, 200));
  }
  return { clickedCount: candidates.length, labels: candidates.map(c => c.getAttribute('aria-label')) };
}

log('Content script loaded.');
