/**
 * Content script (isolated world) — the extension's only presence in the page.
 *
 * It builds no UI. Everything the moderator sees lives in the side panel; this
 * file exists for the three jobs that genuinely require the page itself:
 *   1. Bridging captured GraphQL bodies from the MAIN-world net-hook to the SW
 *   2. Expanding all replies on an open post (clicking Nextdoor's own controls)
 *   3. Reading the currently-expanded post id, and noticing when it closes
 */
import browser from 'webextension-polyfill';

// --- net-hook bridge ---
// The MAIN-world net-hook (src/inject/net-hook.js) cannot talk to the service
// worker directly, so it window.postMessages captured GraphQL bodies to this
// isolated-world content script, which forwards them to the SW. The SW then runs
// the same caching/notification logic the Firefox webRequest interceptor did.
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const d = event.data;
  if (!d || d.source !== 'ndm-net-hook') return;

  if (d.phase === 'start') {
    browser.runtime.sendMessage({ action: 'gqlRequestStarted', url: d.url }).catch(() => {});
  } else if (d.phase === 'body') {
    browser.runtime.sendMessage({ action: 'gqlResponseCaptured', url: d.url, body: d.body }).catch(() => {});
  }
});

// Detect when Nextdoor's own expanded-post overlay closes, so background.js
// (and the side panel, via its broadcast) can drop stale per-post state — the
// side panel's Post Panel tab is the only thing that reacts to this now.
//
// It was deliberately kept out of the floating widget's setup while that widget
// still existed, since it is the side panel's only signal that a post was closed.
// The widget has since been removed and this survived it, as intended.
let closeWatcherStarted = false;
function startExpandedPostCloseWatcher() {
  if (closeWatcherStarted) return;
  closeWatcherStarted = true;
  let wasOpen = false;
  setInterval(() => {
    const isOpen = !!document.querySelector('button[aria-label="Close expanded post"]');
    if (isOpen === wasOpen) return;
    wasOpen = isOpen;
    if (!isOpen) {
      browser.runtime.sendMessage({ action: 'clearExpandedPost' }).catch(() => {});
    }
  }, 500);
}



// Ask the MAIN-world net-hook for the currently-expanded post's id (read from the
// React fiber — invisible to this isolated world). Resolves { postId, shareId } or
// { postId: null } if it can't be determined (DOM/naming changed).
function getExpandedPostIdFromDom() {
  return new Promise(resolve => {
    const reqId = 'ndeid-' + Date.now();
    let settled = false;
    const finish = val => { if (!settled) { settled = true; window.removeEventListener('message', handler); resolve(val); } };
    const handler = e => {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.type !== 'ndExpandedId' || d.reqId !== reqId) return;
      finish({ postId: d.postId || null, shareId: d.shareId || null });
    };
    window.addEventListener('message', handler);
    window.postMessage({ source: 'ndm-get-expanded-id', reqId }, '*');
    setTimeout(() => finish({ postId: null }), 1000);
  });
}

const isPostOverlayOpen = () => !!document.querySelector('button[aria-label="Close expanded post"]');

// Guards against two overlapping click loops — the side panel can fire
// runExpandAllReplies again (Preview here, then Refresh) before the first finishes.
let expandRepliesInProgress = false;

async function expandAllReplies() {
  const overlayOpen = isPostOverlayOpen;
  if (!overlayOpen()) return { error: 'No overlay open' };
  if (expandRepliesInProgress) return { error: 'Already expanding' };
  expandRepliesInProgress = true;
  try {
    return await expandAllRepliesInner(overlayOpen);
  } finally {
    expandRepliesInProgress = false;
  }
}

// The open post's overlay root — Nextdoor's own DOM, id confirmed live via devtools.
// Scoping queries to this (instead of the whole document) is what stops the click
// loop from hitting a stray "see more" button that belongs to a different post
// rendered elsewhere in the page (e.g. a virtualized list keeping other cards mounted).
function getPostOverlayContainer() {
  const closeBtn = document.querySelector('button[aria-label="Close expanded post"]');
  if (!closeBtn) return null;
  return closeBtn.closest('#expanded-post-wrapper') || document;
}

async function expandAllRepliesInner(overlayOpen) {
  const getSeeMoreReplies = () => {
    const container = getPostOverlayContainer();
    if (!container) return [];
    return Array.from(container.querySelectorAll('[role="button"], button'))
      .filter(b => /see \d+ more repl/i.test(b.textContent.trim()));
  };

  // "See more comments" is a div[role="button"] on Nextdoor's React SPA
  const getSeeMoreComments = () => {
    const container = getPostOverlayContainer();
    if (!container) return null;
    return Array.from(container.querySelectorAll('[role="button"], button'))
      .find(el =>
        /see more comments/i.test(el.textContent.trim()) &&
        el.textContent.trim().length < 25
      );
  };

  // A fixed delay is a guess at how long a click's resulting network fetch +
  // re-render will take — under variable network/render latency that guess is
  // sometimes too short, so the loop moves on and misses buttons that hadn't
  // rendered yet (this was the direct cause of an inconsistent-reply-count bug).
  // Waiting for actual DOM mutations to stop, instead of a fixed timeout, adapts
  // to however long this particular click actually takes.
  function waitForQuiet(target, quietMs = 400, timeoutMs = 4000) {
    return new Promise(resolve => {
      let settled = false;
      let quietTimer;
      const finish = () => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(quietTimer);
        clearTimeout(hardTimer);
        resolve();
      };
      const observer = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quietMs);
      });
      observer.observe(target, { childList: true, subtree: true });
      quietTimer = setTimeout(finish, quietMs);
      const hardTimer = setTimeout(finish, timeoutMs);
    });
  }

  let totalClicked = 0;
  let commentStalls = 0;
  const maxRounds = 30;

  for (let round = 0; round < maxRounds; round++) {
    if (!overlayOpen()) break;
    const container = getPostOverlayContainer() || document;

    // PRIORITY 1: Load all top-level comment batches first so all threads are in DOM
    // before the reply expansion pass begins.
    // Nextdoor sometimes leaves "See more comments" rendered even when there is
    // nothing left to load — clicking it is a no-op. Detect that (no DOM growth)
    // and stop after 2 dead clicks instead of hammering it for all 30 rounds.
    const commentLoader = commentStalls < 2 ? getSeeMoreComments() : null;
    if (commentLoader) {
      const before = container.querySelectorAll('*').length;
      commentLoader.click();
      totalClicked++;
      await waitForQuiet(container);
      const after = container.querySelectorAll('*').length;
      if (after <= before) commentStalls++; else commentStalls = 0;
      continue;
    }

    // PRIORITY 2: All top-level comments loaded — expand reply threads
    // Note: "See X more replies" also triggers a PagedComments network fetch,
    // so we wait for the DOM to settle after each click before moving on.
    const replyBtns = getSeeMoreReplies();
    if (replyBtns.length > 0) {
      for (const btn of replyBtns) {
        if (!overlayOpen()) break;
        // The overlay may have re-rendered for a different post since replyBtns
        // was snapshotted above (React can recycle DOM nodes across renders) —
        // skip anything no longer live inside the current post's overlay rather
        // than click a stale reference that could now belong to a different post.
        const liveContainer = getPostOverlayContainer();
        if (!liveContainer || !btn.isConnected || !liveContainer.contains(btn)) continue;
        btn.click();
        totalClicked++;
        await waitForQuiet(liveContainer, 250);
      }
      await waitForQuiet(container);
      continue;
    }

    return { done: true, totalClicked, rounds: round + 1 };
  }

  return { done: false, warning: 'Hit max rounds — may be incomplete', totalClicked };
}


browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Side-panel DOM relays, proxied through background.js (tabs.sendMessage), since
  // these are the two operations that genuinely require reading/acting on the live
  // page rather than already-captured GraphQL data. Manual-only (no auto-trigger) —
  // see getPostOverlayContainer()/expandAllReplies() above for why.
  if (message.action === 'runExpandAllReplies') {
    expandAllReplies().then(sendResponse);
    return true;
  }
  if (message.action === 'getExpandedPostId') {
    getExpandedPostIdFromDom().then(sendResponse);
    return true;
  }
});

// Only queries the document, so it is safe to run at document_start, before body
// exists (querySelector just returns null until then).
startExpandedPostCloseWatcher();
