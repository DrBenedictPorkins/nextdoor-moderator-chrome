import browser from 'webextension-polyfill';
import { initSettings, getModelLabel, PROVIDER_LABELS } from './settings.js';
import { initPostPanel } from './postpanel.js';
import { initReview } from './review.js';

const TABS = ['review', 'postpanel', 'settings'];
const NEXTDOOR_URL = /^https:\/\/([^/]+\.)?nextdoor\.com\//;

const postPanel = initPostPanel();

const tabnav = document.querySelector('.sp-tabnav');
const offsite = document.getElementById('sp-offsite');

let currentTab = 'postpanel';
let onNextdoor = true;
let onModerationFeed = false;

function applyTabVisibility() {
  TABS.forEach(t => {
    document.getElementById(`sp-panel-${t}`).hidden = !onNextdoor || t !== currentTab;
    document.getElementById(`sp-tab-${t}`).classList.toggle('active', t === currentTab);
  });
}

function switchTab(tab) {
  currentTab = tab;
  applyTabVisibility();
  if (onNextdoor && tab === 'postpanel') postPanel.refresh();
}

TABS.forEach(t => {
  document.getElementById(`sp-tab-${t}`).addEventListener('click', () => switchTab(t));
});

// The header shows which provider/model every answer in this panel came from.
// Read from the same storage keys settings.js writes, and re-read on change so
// switching models updates it immediately rather than at next panel open.
const modelBadge = document.getElementById('sp-model-badge');

async function syncModelBadge() {
  const cfg = await browser.storage.local.get(['apiProvider', 'model']).catch(() => ({}));
  const provider = cfg?.apiProvider;
  const label = getModelLabel(provider, cfg?.model);
  const configured = !!(provider && label);
  modelBadge.textContent = configured
    ? `${PROVIDER_LABELS[provider] || provider} · ${label}`
    : 'No model configured';
  modelBadge.title = configured ? `Every analysis and answer uses ${label}` : 'Set a provider and model in Settings';
  modelBadge.classList.toggle('sp-subtitle-unset', !configured);
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('model' in changes || 'apiProvider' in changes)) syncModelBadge();
});

// Replaces the floating widget's "Mod History" link. In the page that was a
// plain <a> that navigated the tab; here a bare href would navigate the side
// panel itself, so drive the Nextdoor tab instead — reusing the active one when
// there is one, rather than piling up duplicate tabs. Bound to both the header
// button (reachable from every tab, and off-site) and the Settings footer link.
async function openModHistory(e) {
  e.preventDefault();
  const url = 'https://nextdoor.com/moderation_history/';
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && NEXTDOOR_URL.test(tab.url)) {
    await browser.tabs.update(tab.id, { url });
  } else {
    await browser.tabs.create({ url });
  }
}

document.getElementById('sp-mod-history-top')?.addEventListener('click', openModHistory);
document.getElementById('sp-mod-history')?.addEventListener('click', openModHistory);

// The whole panel is gated on the active tab being Nextdoor — every surface here
// (Review, Post Panel, and the config they depend on) is meaningless elsewhere,
// so show a single explanation instead of tabs that can't do anything.
let gateSeq = 0;
async function syncSiteGate() {
  const mySeq = ++gateSeq;
  let tab = null;
  try {
    [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  } catch { /* fall through to off-site */ }
  if (mySeq !== gateSeq) return;

  const url = tab?.url || '';
  const next = NEXTDOOR_URL.test(url);
  const changed = next !== onNextdoor;
  onNextdoor = next;

  tabnav.hidden = !onNextdoor;
  offsite.hidden = onNextdoor;

  // Follow the page: the moderation queue means the moderator came to review,
  // anywhere else on Nextdoor means they're looking at an individual post. Only
  // act on the transitions — forcing the tab on every onUpdated event would yank
  // back a deliberate switch to Settings while the page hasn't changed.
  const nowOnFeed = onNextdoor && url.includes('/moderation_feed');
  const enteringFeed = nowOnFeed && !onModerationFeed;
  const leavingFeed = !nowOnFeed && onModerationFeed;
  onModerationFeed = nowOnFeed;

  if (enteringFeed) switchTab('review');
  else if (leavingFeed) switchTab('postpanel');
  else applyTabVisibility();

  // Re-entering Nextdoor: the visible tab's data is whatever it was when we left,
  // so pull it fresh rather than showing stale state.
  if (changed && onNextdoor && currentTab === 'postpanel') postPanel.refresh();
}

browser.tabs.onActivated.addListener(syncSiteGate);
// changeInfo.url is only populated for URLs we hold host permissions for (we have
// no "tabs" permission), so navigating AWAY from Nextdoor reports no url at all.
// status is never permission-gated — key off both so leaving the site is caught.
browser.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (tab.active && (changeInfo.url || changeInfo.status)) syncSiteGate();
});
browser.windows?.onFocusChanged?.addListener(syncSiteGate);

switchTab('postpanel');
initSettings();
initReview();
syncSiteGate();
syncModelBadge();
