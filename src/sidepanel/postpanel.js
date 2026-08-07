/**
 * Post Panel tab — ported from showExportPreview/refreshExportPreview in
 * src/content/content-api.js, adapted from a create/destroy-on-click drawer to a
 * permanent panel section. Pull-based: refreshes on tab activation/URL change and
 * on explicit user action (refresh button re-runs the full "Preview here" fetch),
 * rather than being pushed data by content-api.js — the side panel decides when
 * it needs data.
 *
 * Single unified view (no separate Preview/Chat tabs): the rendered post+thread
 * is inserted as the first item in the chat thread itself, mirroring what the
 * LLM is actually given as context (callLLMChat's own first message), then the
 * moderator chats normally below it.
 */
import browser from 'webextension-polyfill';
import { buildMarkdownFromPostData, renderMarkdownToHtml } from './markdown.js';
import { createPostStore } from './storage.js';
import { showImageLightbox } from './format.js';

let trackedTabId = null;
let currentMarkdown = '';
let currentImageUrls = [];
let currentVideoCount = 0;
let chatHistory = [];
let totalInputTokens = 0;
let totalOutputTokens = 0;
// Screenshots staged via "📷" for the *next* chat message (video/GIF frames,
// mainly) — consumed by that one send: sendChatMessage snapshots and clears
// this, moving the images into that message's bubble permanently rather than
// resending them with every later question. In-memory only, never persisted
// with the rest of the chat — same reasoning as the Review tab's Additional
// Context: base64 images would risk chrome.storage.local's quota. Also reset
// outright whenever the panel moves to a different post.
let capturedChatImages = [];

// Conversations persist per post, so reopening one brings back the scan result
// and any follow-up questions instead of charging for them again.
const chatStore = createPostStore('nd_chat_');
chatStore.purgeExpired();

export function initPostPanel() {
  const countEl = document.getElementById('pp-count');
  const refreshBtn = document.getElementById('pp-refresh-btn');
  const empty = document.getElementById('pp-empty');
  const readyView = document.getElementById('pp-ready');
  const mainView = document.getElementById('pp-main');
  const chatMessages = document.getElementById('pp-chat-messages');
  const chatInput = document.getElementById('pp-chat-input');
  const chatSend = document.getElementById('pp-chat-send');
  const scanBtn = document.getElementById('pp-scan-btn');
  const previewBtn = document.getElementById('pp-preview-btn');
  const captureBtn = document.getElementById('pp-capture-btn');
  const chatImagesEl = document.getElementById('pp-chat-images');

  // Which post (by id) the panel is currently associated with, and whether the
  // moderator has clicked "Preview here" for it yet. A new/different post always
  // resets previewShown to false — never show a stale preview for the wrong post.
  let currentPostId = null;
  let previewShown = false;
  // Comment count of the render currently on screen. Stored alongside a saved
  // conversation so a restore can tell whether the thread has moved on since.
  let currentCommentCount = 0;

  function renderChatImages() {
    chatImagesEl.innerHTML = capturedChatImages.map((src, i) => `
      <div class="rv-context-thumb">
        <img src="${src}" alt="Captured region ${i + 1}" data-idx="${i}">
        <button type="button" class="rv-context-thumb-remove" data-idx="${i}" title="Remove">×</button>
      </div>
    `).join('');
    chatImagesEl.querySelectorAll('.rv-context-thumb img').forEach(img => {
      img.addEventListener('click', () => showImageLightbox(capturedChatImages[Number(img.dataset.idx)]));
    });
    chatImagesEl.querySelectorAll('.rv-context-thumb-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        capturedChatImages.splice(Number(btn.dataset.idx), 1);
        renderChatImages();
      });
    });
  }

  function showEmpty() {
    currentPostId = null;
    previewShown = false;
    empty.hidden = false;
    readyView.hidden = true;
    mainView.hidden = true;
    countEl.textContent = 'No post loaded';
    chatHistory = [];
    chatMessages.innerHTML = '';
    capturedChatImages = [];
    renderChatImages();
  }

  function showReadyPrompt() {
    empty.hidden = true;
    readyView.hidden = false;
    mainView.hidden = true;
    countEl.textContent = 'Post open';
  }

  function showLoading() {
    empty.hidden = true;
    readyView.hidden = true;
    mainView.hidden = false;
    scanBtn.hidden = true;
    chatMessages.innerHTML = '<div class="pp-post-block">Expanding replies and loading preview…</div>';
  }

  function downloadMarkdown() {
    const blob = new Blob([currentMarkdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nextdoor-post-${new Date().toISOString().slice(0, 10)}.md`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function renderFullPreview(post) {
    try {
      const { markdown, totalComments, imageUrls, videoCount } = buildMarkdownFromPostData(post, '');
      currentMarkdown = markdown;
      currentImageUrls = imageUrls || [];
      currentVideoCount = videoCount || 0;
      currentCommentCount = totalComments;
      countEl.textContent = `${totalComments} comment${totalComments !== 1 ? 's' : ''}`;
      scanBtn.hidden = false;
      chatMessages.innerHTML = '';

      const postBlock = document.createElement('div');
      postBlock.className = 'pp-post-block';
      postBlock.innerHTML = renderMarkdownToHtml(markdown);
      const downloadLink = document.createElement('button');
      downloadLink.className = 'pp-download-link';
      downloadLink.textContent = 'Download .md';
      downloadLink.addEventListener('click', downloadMarkdown);
      postBlock.appendChild(downloadLink);
      chatMessages.appendChild(postBlock);
    } catch (err) {
      // Surface the real failure in the panel itself instead of silently leaving
      // a stale/blank render — we have no other way to see errors from here.
      console.error('[NDM] renderFullPreview failed:', err);
      chatMessages.innerHTML = `<div style="color:#c62828; font-size:12px; white-space:pre-wrap; padding:14px 16px;">Preview failed: ${err.message}\n\n${err.stack || ''}</div>`;
      countEl.textContent = 'Render error';
    }
  }

  function countComments(post) {
    let n = 0;
    const walk = (edges) => {
      if (!Array.isArray(edges)) return;
      for (const e of edges) {
        if (e?.node?.comment) n++;
        walk(e.node?.replies?.edgesV2 || e.node?.replies?.edges);
      }
    };
    walk(post?.comments?.pagedComments?.edgesV2 || post?.comments?.pagedComments?.edges);
    return n;
  }

  // Expanding replies finishes in the PAGE before the data finishes arriving in
  // the CACHE: each "see N more replies" click fires a PagedComments fetch whose
  // response background merges into postDataCache asynchronously. expandAllReplies
  // only waits for DOM quiet, and quiet-before-the-fetch-responds is
  // indistinguishable from quiet-after-it-lands — so a single read here can race
  // the last merges and render a post missing replies. Poll until the comment
  // count stops growing instead of trusting one post-expansion read.
  async function getPostWhenSettled(tabId, postId) {
    let post = null;
    let lastCount = -1;
    let stableReads = 0;
    for (let i = 0; i < 20; i++) {
      const resp = await browser.runtime
        .sendMessage({ action: 'getPostById', tabId, postId })
        .catch(() => null);
      if (resp?.post) post = resp.post;
      const count = countComments(post);
      if (count === lastCount && post) {
        if (++stableReads >= 2) break; // ~500ms with no new comments — merges done
      } else {
        stableReads = 0;
        lastCount = count;
      }
      await new Promise(r => setTimeout(r, 250));
    }
    return post;
  }

  // `discardChat` is the refresh path: the moderator has already been warned and
  // agreed to lose the conversation. Otherwise this is a first load of the post,
  // where any saved conversation for it is restored.
  async function doPreview({ discardChat = false } = {}) {
    const tabId = trackedTabId;
    if (tabId == null || currentPostId == null) return;
    const postId = currentPostId;
    previewShown = true;
    showLoading();
    await browser.runtime.sendMessage({ action: 'runExpandAllReplies', tabId }).catch(() => null);
    // getPostById reads postDataCache directly by id — unlike getLastExpandedPost,
    // it doesn't depend on the lastExpandedPostId pointer, which is stale/cleared
    // whenever this post was reopened without a fresh network fetch (see the
    // pollDomPostId comment below for why that happens).
    const post = await getPostWhenSettled(tabId, postId);
    if (!post) { showReadyPrompt(); previewShown = false; return; }

    if (discardChat) await chatStore.clear(postId);
    const saved = discardChat ? null : await chatStore.load(postId);
    if (postId !== currentPostId) return; // a different post opened while we loaded

    chatHistory = [];
    totalInputTokens = 0;
    totalOutputTokens = 0;
    capturedChatImages = [];
    renderChatImages();
    renderFullPreview(post);
    if (saved) restoreChat(saved);
  }
  previewBtn.addEventListener('click', () => doPreview());

  captureBtn.addEventListener('click', async () => {
    if (trackedTabId == null) return;
    captureBtn.disabled = true;
    const originalLabel = captureBtn.textContent;
    captureBtn.textContent = '…';
    let resp;
    try {
      resp = await browser.runtime.sendMessage({ action: 'startRegionCapture', tabId: trackedTabId });
    } catch { /* resp stays undefined; handled below */ }
    captureBtn.disabled = false;
    captureBtn.textContent = originalLabel;
    if (resp?.success && resp.dataUrl) {
      capturedChatImages.push(resp.dataUrl);
      renderChatImages();
    } else if (!resp?.cancelled) {
      addNoticeBubble(`Capture failed: ${resp?.error || 'Unknown error'}`);
    }
  });

  async function persistChat() {
    if (!currentPostId || chatHistory.length === 0) return;
    await chatStore.save(currentPostId, {
      chatHistory,
      commentCount: currentCommentCount,
      totalInputTokens,
      totalOutputTokens,
    });
  }

  // Bubbles are rebuilt from {role, content} rather than stored as HTML: unlike
  // the Review tab's analysis card there are no interactive controls inside them,
  // so the markdown renderer reproduces them exactly.
  function restoreChat(saved) {
    chatHistory = Array.isArray(saved.chatHistory) ? saved.chatHistory.slice() : [];
    totalInputTokens = saved.totalInputTokens || 0;
    totalOutputTokens = saved.totalOutputTokens || 0;
    chatHistory.forEach(m => addBubble(m.content, m.role === 'user'));

    // The post above was just re-read from the cache, so it reflects the thread as
    // it is now; the restored answers were written about the thread as it was.
    // Say so rather than letting a stale scan read as current — but leave the call
    // to the moderator, since refreshing costs the conversation.
    const savedCount = saved.commentCount;
    if (savedCount != null && savedCount !== currentCommentCount) {
      const delta = currentCommentCount - savedCount;
      addNoticeBubble(
        `The thread has changed since this conversation — ${savedCount} comment${savedCount !== 1 ? 's' : ''} then, ${currentCommentCount} now ` +
        `(${delta > 0 ? `${delta} added` : `${-delta} removed`}). The answers above were written about the earlier version.`,
        { label: 'Refresh & clear chat', onClick: () => refreshNow({ alreadyConfirmed: true }) }
      );
    }
  }

  // Handles both a fresh getLastExpandedPost pull (refresh()) and the
  // expandedPostReady broadcast — same decision either way: a new/different post
  // resets to the "Preview here" prompt; the already-previewed post is left alone
  // (avoids clobbering a rendered preview + ongoing chat on redundant broadcasts,
  // e.g. our own PagedComments merges resending expandedPostReady for the same post).
  function handleIncomingPost(post) {
    if (!post) { showEmpty(); return; }
    const postId = post.id != null ? String(post.id) : null;
    if (postId !== currentPostId) {
      currentPostId = postId;
      previewShown = false;
    }
    if (!previewShown) showReadyPrompt();
  }

  // Reopening the SAME post after closing it often serves the detail view from
  // Nextdoor's own Apollo cache with no new network request at all — our net-hook
  // only sees actual fetch/XHR calls, so no fresh expandedPostReady broadcast ever
  // fires for that reopen. Polling getExpandedPostId (reads the live DOM/React
  // fiber directly, not GraphQL capture) is the only reliable way to detect "a
  // post is open right now" in that case. getPostById then pulls whatever's
  // already cached for that id — postDataCache isn't cleared on close, only the
  // lastExpandedPostId *pointer* is, so the data is still there.
  let currentDomPostId = null;
  // getExpandedPostIdFromDom (content-api.js) has its own ~1s internal timeout
  // for a postMessage round-trip to the MAIN-world net-hook — under enough
  // main-thread jank (e.g. a drag gesture elsewhere on the page) that round-trip
  // can miss it and come back null even though the post is still open. Acting on
  // a single null read wiped live panel state (including screenshots staged for
  // the chat) on nothing more than a timing blip. Require two in a row.
  let nullPolls = 0;
  async function pollDomPostId() {
    if (trackedTabId == null) return;
    const resp = await browser.runtime.sendMessage({ action: 'getExpandedPostId', tabId: trackedTabId }).catch(() => null);
    const postId = resp?.postId != null ? String(resp.postId) : null;
    if (postId) nullPolls = 0;
    else if (++nullPolls < 2) return;
    if (postId === currentDomPostId) return;
    currentDomPostId = postId;
    if (!postId) { showEmpty(); return; }
    const postResp = await browser.runtime.sendMessage({ action: 'getPostById', tabId: trackedTabId, postId }).catch(() => null);
    handleIncomingPost(postResp?.post || null);
  }
  setInterval(pollDomPostId, 1000);

  async function findActiveNextdoorTab() {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (tab && tab.url && /^https:\/\/([^/]+\.)?nextdoor\.com\//.test(tab.url)) {
      return tab.id;
    }
    return null;
  }

  // refresh() has no protection on its own against overlapping calls (it's invoked
  // from several independent triggers: tabs.onActivated, tabs.onUpdated, the
  // expandedPostReady broadcast listener, and manual button clicks) — two calls
  // can race, and whichever resolves LAST wins regardless of which started last.
  // A stale, slow call resolving after a newer one was already showing the right
  // post could stomp it back to "no post". This sequence token discards any
  // refresh() whose result arrives after a newer one has already started.
  let refreshSeq = 0;

  async function refresh() {
    const mySeq = ++refreshSeq;
    const tabId = await findActiveNextdoorTab();
    if (mySeq !== refreshSeq) return;
    // A transient "no active Nextdoor tab" result (e.g. a brief focus blip while
    // clicking around the panel itself) must never wipe out a previously-known
    // good tabId — doing so would permanently break broadcast matching below
    // (message.tabId !== trackedTabId), since nothing else ever re-establishes
    // it. Only ever move trackedTabId forward to a real, freshly-confirmed tab.
    if (tabId != null) trackedTabId = tabId;
    if (tabId == null) {
      if (trackedTabId == null) showEmpty();
      return;
    }
    const resp = await browser.runtime.sendMessage({ action: 'getLastExpandedPost', tabId }).catch(() => null);
    if (mySeq !== refreshSeq) return;
    handleIncomingPost(resp?.post || null);
  }

  // Plain refresh() only re-checks WHICH post is open; for the already-previewed
  // post handleIncomingPost deliberately leaves the render alone, so the button
  // looked like it did nothing. Re-run the same work "Preview here" does instead:
  // re-expand all replies on the page and re-pull + re-render the post, so newly
  // added comments show up. Resolve the post from the live DOM rather than the
  // lastExpandedPostId pointer, which is cleared/stale on an Apollo-cached reopen.
  async function refreshNow({ alreadyConfirmed = false } = {}) {
    // Refresh rebuilds the whole view from a fresh read, which means the
    // conversation goes with it — including a scan that cost a real LLM call. Ask
    // first rather than discarding it on what may have been a "reload the post"
    // click. Only when there is something to lose.
    if (!alreadyConfirmed && chatHistory.length > 0) {
      const turns = chatHistory.filter(m => m.role === 'user').length;
      addNoticeBubble(
        `Refreshing reloads the post and clears this conversation (${turns} question${turns !== 1 ? 's' : ''} and their answers). This cannot be undone.`,
        { label: 'Refresh & clear chat', onClick: () => refreshNow({ alreadyConfirmed: true }) },
        { label: 'Cancel', onClick: () => {} }
      );
      return;
    }

    refreshBtn.disabled = true;
    try {
      const tabId = await findActiveNextdoorTab();
      if (tabId != null) trackedTabId = tabId;
      if (trackedTabId == null) { showEmpty(); return; }

      const resp = await browser.runtime
        .sendMessage({ action: 'getExpandedPostId', tabId: trackedTabId })
        .catch(() => null);
      const postId = resp?.postId != null ? String(resp.postId) : null;
      currentDomPostId = postId;
      if (!postId) { showEmpty(); return; }

      currentPostId = postId;
      await doPreview({ discardChat: true });
    } finally {
      refreshBtn.disabled = false;
    }
  }

  refreshBtn.addEventListener('click', () => refreshNow());

  // `images`, when given, are whatever was staged in the attachment tray at the
  // moment this message was sent — they move into the bubble permanently (for
  // the rest of this live session; see the in-memory note on capturedChatImages)
  // rather than staying in the tray to be resent with every later question.
  function addBubble(text, isUser, images = []) {
    const div = document.createElement('div');
    div.className = isUser ? 'pp-bubble pp-bubble-user' : 'pp-bubble pp-bubble-assistant';
    if (isUser) div.textContent = text; else { div.innerHTML = renderMarkdownToHtml(text); addCopySnippetButtons(div); }
    if (images.length > 0) {
      const row = document.createElement('div');
      row.className = 'pp-bubble-images';
      images.forEach((src, i) => {
        const thumb = document.createElement('img');
        thumb.src = src;
        thumb.alt = `Attached image ${i + 1}`;
        thumb.className = 'pp-bubble-thumb';
        thumb.addEventListener('click', () => showImageLightbox(src));
        row.appendChild(thumb);
      });
      div.appendChild(row);
    }
    chatMessages.appendChild(div);
    div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return div;
  }

  // Scan for violations reports each item as a fixed "N. **Content:** "quote""
  // field (see SCAN_PROMPT below) — that quote is already the moderator's own
  // "copy the first words and Ctrl+F it on the page" workflow, verbatim. This
  // finds those lines after markdown rendering and adds a one-click copy of the
  // first ~12 words, so there's no manual scrolling/selecting to do it. Runs on
  // every assistant bubble (live or restored from history) — harmless no-op on
  // ordinary Q&A answers, since they never take this exact "N. Content: "..."" shape.
  function addCopySnippetButtons(container) {
    const contentLine = /Content:\s*"(.+?)"\s*$/;
    Array.from(container.children).forEach(div => {
      const match = (div.textContent || '').match(contentLine);
      if (!match) return;
      const snippet = match[1].trim().split(/\s+/).slice(0, 12).join(' ');
      if (!snippet) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pp-copy-snippet-btn';
      btn.textContent = '📋 Copy to find on page';
      btn.title = "Copies the start of this text — paste into the page's Find (Ctrl/Cmd+F) to jump to it";
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(snippet).then(() => {
          const original = btn.textContent;
          btn.textContent = '✓ Copied';
          setTimeout(() => { btn.textContent = original; }, 1200);
        }).catch(() => {});
      });
      div.appendChild(btn);
    });
  }

  // Panel-generated, not part of the conversation — deliberately a different colour
  // from both bubble styles so it never reads as something the model said, and
  // never persisted, since it describes a moment rather than the exchange.
  function addNoticeBubble(text, primary = null, secondary = null) {
    const div = document.createElement('div');
    div.className = 'pp-notice';
    const msg = document.createElement('div');
    msg.textContent = text;
    div.appendChild(msg);
    if (primary || secondary) {
      const row = document.createElement('div');
      row.className = 'pp-notice-actions';
      [secondary, primary].forEach(action => {
        if (!action) return;
        const btn = document.createElement('button');
        btn.className = action === primary ? 'pp-notice-btn pp-notice-btn-primary' : 'pp-notice-btn';
        btn.textContent = action.label;
        btn.addEventListener('click', () => { div.remove(); action.onClick(); });
        row.appendChild(btn);
      });
      div.appendChild(row);
    }
    chatMessages.appendChild(div);
    div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return div;
  }

  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  });
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend.click(); }
  });

  // The scan is the one call whose output a moderator reads repeatedly across
  // many posts, so its shape is pinned rather than left to the model — a fixed
  // five-field block per reported item makes it skimmable and makes a missing
  // guideline citation obvious.
  //
  // It reports only violations and borderline calls. Every item is still assessed
  // — the opening line says how many — but a block per clean comment buried the
  // one thing worth looking at under eight that weren't. Borderline stays in: it
  // means "text alone can't settle this", which is precisely a human's job.
  const SCAN_PROMPT = [
    'Scan this entire post and every comment/reply (including replies to other neighbors) for Nextdoor community guideline violations.',
    '',
    'Assess the original post and every comment yourself, but REPORT only the items that actually violate a guideline or are close enough to need a human decision. Items that plainly comply are not worth the moderator\'s time — leave them out entirely.',
    '',
    'Open with one line stating what you assessed and how many items that was, for example: "Assessed the original post and all 8 comments."',
    '',
    'Then, for each item worth reporting — in the order it appears, original post first — output a bold heading line naming it (**Original post**, **Comment 4**), followed by exactly these five numbered fields, in this order, with these exact labels:',
    '',
    '1. **Author:** the display name',
    '2. **Content:** a short verbatim quote of the offending text, in double quotes',
    '3. **Guideline Check:** one or two sentences on what the content is doing that is a problem',
    '4. **Guideline Reference:** the specific guideline it violates, cited by its number and name as it appears in the guidelines',
    '5. **Confidence:** exactly one of — Clear violation. / Borderline, needs human judgment.',
    '',
    'Before reporting an item, ALL THREE of these must hold. If any one fails, leave the item out entirely:',
    '- A specific guideline prohibits the content as written, and you can quote the clause that does it. Content that merely reads as unusual, low-effort, commercial-sounding, or "worth a look" is not a finding.',
    '- That guideline\'s own scope covers this kind of content. Bullets under a guideline\'s NOT ALLOWED list inherit the definition stated at the top of that guideline — a bullet never reaches content the definition never covered. Check the definition before citing a bullet under it.',
    '- The content is not being reported merely because it is absent from an ALLOWED list. Those lists are examples of things explicitly permitted, not a whitelist. Anything no guideline prohibits is allowed, even when nothing names it. If no guideline addresses this kind of content at all, there is no violation.',
    '',
    'Reporting content that does not violate a guideline is itself a failure — a moderator acting on it removes a neighbor\'s post for no reason. When no guideline clearly applies, report nothing and say so.',
    '',
    'Rules:',
    '- Report both clear violations and borderline calls. "Borderline" means the FACTS cannot be settled from the text — for example, you cannot tell whether the neighbor recommending a business owns it. It does NOT mean the guideline is a stretch. If the guideline does not squarely cover this kind of content, that is not borderline; leave the item out.',
    '- Never report an item whose verdict is that it complies. Do not list it, do not mention it in passing, do not summarise the clean items as a group.',
    '- Never merge, rename, reorder, or omit a field, and never add extra numbered fields.',
    '- If NOTHING violates a guideline, output the opening line and then two or three sentences plainly describing what the post is about and what the replies are doing, ending by stating that nothing violates the guidelines. In that case output no numbered fields at all.',
    '- Do not include any other sections, headings, closing summaries, or commentary.',
  ].join('\n');

  async function sendChatMessage(question, displayText) {
    if (!question || chatSend.disabled) return;

    // Consumed by this send only — not resent with later questions. currentImageUrls
    // (the post's own actual images) is unaffected and keeps going out with every
    // question, same as always; only moderator-captured screenshots work this way.
    const attachedImages = capturedChatImages;
    capturedChatImages = [];
    renderChatImages();

    addBubble(displayText ?? question, true, attachedImages);
    chatHistory.push({ role: 'user', content: question });
    chatSend.disabled = true;
    scanBtn.disabled = true;
    chatSend.textContent = '…';

    const typingBubble = addBubble('…', false);

    try {
      const resp = await browser.runtime.sendMessage({
        action: 'chatAboutPost',
        question,
        markdown: currentMarkdown,
        imageUrls: [...currentImageUrls, ...attachedImages],
        history: chatHistory.slice(0, -1),
      });
      const answer = resp?.answer || 'No response.';
      typingBubble.innerHTML = renderMarkdownToHtml(answer);
      addCopySnippetButtons(typingBubble);
      chatHistory.push({ role: 'assistant', content: answer });

      const inTok = resp?.inputTokens;
      const outTok = resp?.outputTokens;
      const cachedTok = resp?.cachedTokens || 0;
      if (inTok != null || outTok != null) {
        totalInputTokens += inTok || 0;
        totalOutputTokens += outTok || 0;
        const statsEl = document.createElement('div');
        statsEl.className = 'pp-chat-stats';
        // `in` is the full prompt size; the cached portion of it is billed at a
        // fraction, so show it rather than leave the number looking alarming.
        const cachedNote = cachedTok > 0 ? ` (${cachedTok.toLocaleString()} cached)` : '';
        statsEl.textContent = `${(inTok || 0).toLocaleString()} in${cachedNote} · ${(outTok || 0).toLocaleString()} out  |  session: ${totalInputTokens.toLocaleString()} in · ${totalOutputTokens.toLocaleString()} out`;
        chatMessages.appendChild(statsEl);
      }

      // Save once the exchange is complete. A failed call leaves the user's turn
      // in chatHistory with no answer — persisting that would restore a question
      // that was never answered.
      await persistChat();
    } catch (err) {
      typingBubble.textContent = 'Error: ' + err.message;
      typingBubble.classList.add('pp-bubble-error');
    }

    chatSend.disabled = false;
    scanBtn.disabled = false;
    chatSend.textContent = 'Ask';
    typingBubble.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  chatSend.addEventListener('click', () => {
    const question = chatInput.value.trim();
    if (!question) return;
    chatInput.value = '';
    chatInput.style.height = 'auto';
    sendChatMessage(question);
  });

  scanBtn.addEventListener('click', () => {
    if (!currentMarkdown) {
      // No point spending an LLM call — nothing's been previewed yet, so there's
      // no post/thread content to scan.
      addBubble('Click "Preview here" first — I need the full post and replies loaded before I can scan for violations.', false);
      return;
    }
    // Same requirement the Review tab enforces: video can't be sent to the LLM,
    // so a scan that ignores it would silently judge text only and read as a
    // clean result. The chat input is this tab's equivalent of Review's
    // "Additional Context" field, so any message the moderator has already sent
    // counts as the description.
    const hasDescribedVideo = chatHistory.some(m => m.role === 'user');
    if (currentVideoCount > 0 && !hasDescribedVideo) {
      addBubble(
        `This post contains ${currentVideoCount} video attachment${currentVideoCount !== 1 ? 's' : ''}, which cannot be sent to the AI — only the text and images can. ` +
        `Describe what the video shows in the message box below and send it first, then run the scan so the result accounts for it.`,
        false
      );
      return;
    }
    sendChatMessage(SCAN_PROMPT, 'Scan for violations');
  });

  // Track the active Nextdoor tab so switching tabs (or navigating within one)
  // updates the panel automatically.
  browser.tabs.onActivated.addListener(refresh);
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId === trackedTabId && changeInfo.status === 'complete') refresh();
  });

  // Opening a post is a same-tab SPA state change with no URL change, so neither
  // tabs.onActivated nor tabs.onUpdated fires for it — background.js broadcasts
  // expandedPostReady/expandedPostCleared for exactly this case (see gqlRequestStarted/
  // gqlResponseCaptured and mergePagedComments in background.js).
  browser.runtime.onMessage.addListener((message) => {
    if (message.tabId == null || message.tabId !== trackedTabId) return;
    if (message.action === 'expandedPostReady') {
      handleIncomingPost(message.post);
    }
    if (message.action === 'expandedPostCleared') {
      // The moderator closed Nextdoor's own post overlay with nothing else
      // opened — don't keep showing the now-closed post.
      showEmpty();
    }
  });

  showEmpty();
  refresh();

  return { refresh };
}
