/**
 * Content script (isolated world) — the extension's only presence in the page.
 *
 * Everything the moderator sees persists in the side panel; this file exists
 * for the jobs that genuinely require the page itself:
 *   1. Bridging captured GraphQL bodies from the MAIN-world net-hook to the SW
 *   2. Expanding all replies on an open post (clicking Nextdoor's own controls)
 *   3. Reading the currently-expanded post id, and noticing when it closes
 *   4. A transient drag-to-select overlay for the side panel's screenshot
 *      capture (startRegionSelection) — removed the moment a region is picked
 *      or the capture is cancelled, never a persistent page fixture
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

// Lets the moderator drag a rectangle over the live page (e.g. a video frame or
// GIF that can't be sent to the LLM as text) and hands the selected region back
// to background.js, which screenshots the tab and crops to it — see
// startRegionCapture in background.js. Resolves { cancelled: true } on Escape or
// a too-small drag, otherwise { cancelled: false, rect: {x, y, width, height, dpr} }
// in CSS-pixel viewport coordinates (dpr included so the crop can be done against
// the full-resolution capture captureVisibleTab returns).
function startRegionSelection() {
  return new Promise(resolve => {
    let settled = false;
    let dragging = false;
    let startX = 0;
    let startY = 0;

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; z-index:2147483647; cursor:crosshair; background:rgba(0,0,0,0.12);';
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed; display:none; pointer-events:none; z-index:2147483647; border:2px solid #2563eb; background:rgba(37,99,235,0.15); box-sizing:border-box;';
    document.body.appendChild(overlay);
    document.body.appendChild(box);

    function cleanup() {
      window.removeEventListener('keydown', onKeydown, true);
      overlay.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      if (moveRaf) cancelAnimationFrame(moveRaf);
      overlay.remove();
      box.remove();
    }

    function finish(value) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }

    function onKeydown(e) {
      if (e.key === 'Escape') finish({ cancelled: true });
    }

    function onMouseDown(e) {
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      Object.assign(box.style, { left: startX + 'px', top: startY + 'px', width: '0px', height: '0px', display: 'block' });
    }

    // Native mousemove can fire dozens of times/sec during a drag; writing the
    // box's style on every single one is enough main-thread work to jank other
    // unrelated page activity (observed: it could delay net-hook postMessage
    // round-trips past their own 1s timeout, e.g. content-api.js's
    // getExpandedPostIdFromDom, which postpanel.js polls every 1s and treats a
    // single timeout as "the post closed" — wiping live panel state mid-drag).
    // rAF-batching the write to once per frame removes that risk.
    let pendingMove = null;
    let moveRaf = null;
    function onMouseMove(e) {
      if (!dragging) return;
      pendingMove = e;
      if (moveRaf) return;
      moveRaf = requestAnimationFrame(() => {
        moveRaf = null;
        const ev = pendingMove;
        const x = Math.min(ev.clientX, startX);
        const y = Math.min(ev.clientY, startY);
        Object.assign(box.style, { left: x + 'px', top: y + 'px', width: Math.abs(ev.clientX - startX) + 'px', height: Math.abs(ev.clientY - startY) + 'px' });
      });
    }

    function onMouseUp(e) {
      if (!dragging) return;
      dragging = false;
      const x = Math.min(e.clientX, startX);
      const y = Math.min(e.clientY, startY);
      const width = Math.abs(e.clientX - startX);
      const height = Math.abs(e.clientY - startY);
      if (width < 8 || height < 8) { finish({ cancelled: true }); return; }
      // Hide the overlay/box before the tab is captured so they don't show up in
      // the screenshot — background.js captures only after this promise resolves,
      // so give the hide two frames to actually paint first.
      overlay.style.display = 'none';
      box.style.display = 'none';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        finish({ cancelled: false, rect: { x, y, width, height, dpr: window.devicePixelRatio || 1 } });
      }));
    }

    window.addEventListener('keydown', onKeydown, true);
    overlay.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
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
  if (message.action === 'startRegionCapture') {
    startRegionSelection().then(sendResponse);
    return true;
  }
});

// Only queries the document, so it is safe to run at document_start, before body
// exists (querySelector just returns null until then).
startExpandedPostCloseWatcher();
