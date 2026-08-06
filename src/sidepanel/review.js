/**
 * Review tab — ported from createContentOverlay/showVoteFooter/showErrorOverlay
 * and extractModerationData in src/content/content-api.js, adapted from a
 * floating/resizable modal into a permanent panel section (no backdrop, no
 * resize handle, no floating positioning — the side panel itself is the fixed
 * container now). "Analyze with AI" now awaits analyzeContent's response
 * directly instead of listening for a separate analysisResult/analysisError
 * push-back message — the side panel is a persistent caller, same reasoning
 * that already applied to Post Panel's chatAboutPost.
 */
import browser from 'webextension-polyfill';
import {
  parseModerationSummary,
  formatAIAnalysis,
  renderImageAttachments,
  attachImageClickHandlers,
  formatConversationThread,
  attachThreadToggleHandlers,
  formatModerationDetails,
  styleVoteSuggestion,
} from './format.js';
import { createPostStore } from './storage.js';

/**
 * navigator.clipboard.writeText rejects in some side-panel states (most commonly
 * "Document is not focused"), and an unhandled rejection is invisible — the button
 * simply does nothing, which is exactly how this surfaced. Fall back to a
 * temporary textarea + execCommand, and report failure to the caller so it can
 * say so rather than silently no-op.
 */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.setAttribute('readonly', '');
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (err) {
      console.error('[Review] Copy failed:', err);
      return false;
    }
  }
}

// Shared button feedback so a failed copy can never look like a successful one.
async function copyWithFeedback(btn, text, label = 'Copy') {
  const ok = await copyToClipboard(text);
  btn.textContent = ok ? 'Copied!' : 'Copy failed';
  setTimeout(() => { btn.textContent = label; }, 1600);
  return ok;
}

const reviewStore = createPostStore('nd_review_');
const savePostReview = reviewStore.save;
const loadPostReview = reviewStore.load;
const clearPostReview = reviewStore.clear;
reviewStore.purgeExpired();

/**
 * Extract moderation data from the raw captured /ModerationFeed GraphQL response.
 * Ported verbatim from content-api.js's extractModerationData(), except it now
 * takes the raw response as a parameter instead of reading a content-script-local
 * module variable — the side panel pulls it directly from background's
 * capturedApiData via the getModerationFeedData action.
 */
function extractModerationData(moderationFeedData, pageUrl = '') {
  console.log('[Review] extractModerationData() called');
  console.log('[Review] moderationFeedData exists:', !!moderationFeedData);
  console.log('[Review] moderationFeedData value:', moderationFeedData);

  if (!moderationFeedData) {
    console.error('[Review] No moderation feed data available');
    return {
      success: false,
      error: 'No moderation feed data available. Try refreshing the page.',
    };
  }

  try {
    const feedItems = moderationFeedData?.data?.me?.moderationFeed?.feedItems;

    if (!feedItems || feedItems.length === 0) {
      return {
        success: false,
        error: 'No feed items found in API response',
      };
    }

    // Get the first feed item (the current post being viewed)
    const feedItem = feedItems[0];
    const post = feedItem.post;

    if (!post) {
      return {
        success: false,
        error: 'No post data found in feed item',
      };
    }

    // Extract original post data
    // Use styledBody.text if available (contains full text including title), otherwise fall back to body
    // For POLL posts, content lives in post.poll (body and styledBody are empty)
    const pollText = post.poll
      ? [
          post.poll.question,
          post.poll.description,
          post.poll.options?.length
            ? 'Poll options: ' + post.poll.options.map(o => o.label).join(' / ')
            : '',
        ].filter(Boolean).join('\n')
      : '';
    const postContent = post.styledBody?.text || post.body || pollText;

    // Check for media attachments (images, videos, links)
    const mediaAttachments = post.mediaAttachments || [];
    const imageUrls = mediaAttachments.filter(m => m.type === 'PHOTO').map(m => m.url).filter(Boolean);
    const videoCount = mediaAttachments.filter(m => m.type === 'VIDEO').length;
    // Check for link/URL attachments (shared posts, external links)
    const postUrl = post.url || post.link || post.sharedPost?.url || '';
    const hasLink = !!postUrl || !!post.sharedPost;
    const hasMedia = mediaAttachments.length > 0 || hasLink;
    const mediaTypes = [
      ...mediaAttachments.map(m => m.type),
      ...(hasLink ? ['LINK'] : [])
    ].join(', ') || '';

    const originalPost = {
      id: post.id,
      legacyId: feedItem.legacyAnalyticsId,
      content: postContent || (hasLink ? `[Link: ${postUrl || 'shared post'}]` : ''),
      hasMedia: hasMedia,
      mediaTypes: mediaTypes,
      mediaCount: mediaAttachments.length + (hasLink ? 1 : 0),
      imageUrls: imageUrls,
      videoCount: videoCount,
      author: post.author?.displayName || 'Unknown',
      authorUrl: post.author?.url || '',
      createdAt: post.createdAt?.asDateTime?.relativeTime || '',
      neighborhood: post.author?.originationNeighborhood?.shortName || '',
      // Self-promotion detection fields (captured for future use). See background.js
      // GUIDELINE 6 for context.
      postType: post.postType ?? null,
      classified: post.classified ?? null,
      classifiedInfo: post.classifiedInfo ?? null,
      localServiceData: post.localServiceData ?? null,
      authorType: post.author?.type ?? post.author?.authorType ?? null,
    };

    console.log(`[NDM] Self-promo fields for post ${originalPost.id}: postType=${JSON.stringify(originalPost.postType)}, classified=${JSON.stringify(originalPost.classified)}, classifiedInfo=${JSON.stringify(originalPost.classifiedInfo)}, localServiceData=${JSON.stringify(originalPost.localServiceData)}, authorType=${JSON.stringify(originalPost.authorType)}`);

    // Extract moderation info with details
    const moderationInfo = {
      hasModerationSummary: !!feedItem.moderationInfo?.moderationSummaryV3,
      moderationSummary: feedItem.moderationInfo?.moderationSummaryV3 || null,
    };

    // Parse moderation summary for display-friendly format
    let moderationDetails = null;
    if (moderationInfo.moderationSummary) {
      moderationDetails = parseModerationSummary(moderationInfo.moderationSummary);
    }

    // Recursively search for flagged comments at any depth and build conversation threads
    const flaggedComments = [];

    /**
     * Recursively search comments and nested replies for flagged content
     * @param {Array} edges - Array of comment edges from GraphQL response
     * @param {Array} parentThread - Array of parent comments leading to this level
     * @param {number} depth - Current nesting depth
     * @param {Array} allComments - Collection of all processed comments (for sibling search)
     */
    function findFlaggedCommentsRecursive(edges, parentThread = [], depth = 0, allComments = []) {
      if (!edges || edges.length === 0) return;

      edges.forEach((edge) => {
        const comment = edge.node?.comment;
        if (!comment) return;

        // Use styledBody.text if available (full text), otherwise fall back to body
        const commentContent = comment.styledBody?.text || comment.body || '';

        const commentMediaAttachments = comment.mediaAttachments || [];
        const commentData = {
          id: comment.id,
          legacyId: comment.legacyCommentId,
          content: commentContent,
          author: comment.author?.displayName || 'Unknown',
          authorUrl: comment.author?.url || '',
          authorUserId: comment.author?.user?.id || null,  // Store user ID for matching
          createdAt: comment.createdAt?.asDateTime?.relativeTime || '',
          createdAtEpoch: comment.createdAt?.epochMillis || null,  // Store timestamp for filtering
          depth: depth,
          tags: comment.tags || [],  // Store tags array
          imageUrls: commentMediaAttachments.filter(m => m.type === 'PHOTO').map(m => m.url).filter(Boolean),
          // Self-promotion detection fields (captured for future use). See background.js
          // GUIDELINE 6 for context.
          detectedBusiness: comment.detectedBusiness ?? null,
          authorType: comment.author?.type ?? comment.author?.authorType ?? null,
        };

        // Add this comment to the global collection for sibling search
        allComments.push(commentData);

        console.log(`[NDM] Self-promo fields for comment ${commentData.id}: detectedBusiness=${JSON.stringify(commentData.detectedBusiness)}, authorType=${JSON.stringify(commentData.authorType)}`);

        // Check if this comment is flagged
        if (comment.moderationInfo?.moderationSummaryV3) {
          const commentModerationDetails = parseModerationSummary(comment.moderationInfo.moderationSummaryV3);

          // Build smart minimal conversation thread based on tags
          const smartThread = buildSmartConversationThread(commentData, parentThread, allComments);

          flaggedComments.push({
            ...commentData,
            moderationSummary: comment.moderationInfo.moderationSummaryV3,
            moderationDetails: commentModerationDetails,
            // Smart conversation thread: only relevant context
            conversationThread: smartThread,
          });
        }

        // Recursively search nested replies
        // Note: Replies are at edge.node.replies.edges, NOT comment.pagedNestedReplies
        const nestedReplies = edge.node?.replies?.edges || [];
        if (nestedReplies.length > 0) {
          findFlaggedCommentsRecursive(
            nestedReplies,
            [...parentThread, commentData], // Add current comment to thread
            depth + 1,
            allComments  // Pass along the collection
          );
        }
      });
    }

    /**
     * Build a smart minimal conversation thread based on @mention tags
     * @param {Object} flaggedComment - The flagged comment data
     * @param {Array} parentThread - Full parent chain including original post
     * @param {Array} allComments - Collection of all processed comments (for sibling search)
     * @returns {Array} - Minimal conversation thread with only relevant context
     */
    function buildSmartConversationThread(flaggedComment, parentThread, allComments = []) {
      console.log('[Review] Building smart thread for flagged comment:', flaggedComment.id);
      console.log('[Review] Flagged comment tags:', JSON.stringify(flaggedComment.tags, null, 2));
      console.log('[Review] Parent thread length:', parentThread.length);
      console.log('[Review] All comments available for search:', allComments.length);

      // Always include original post (depth: -1)
      const originalPost = parentThread.find(msg => msg.depth === -1);
      if (!originalPost) {
        console.warn('[Review] No original post found in parent thread');
        return [flaggedComment];
      }

      // Analyze tags array for USER mentions at start of text
      const userTags = (flaggedComment.tags || []).filter(tag =>
        tag.type === 'USER' &&
        tag.startIndex !== undefined &&
        tag.startIndex < 20  // Mentioned at/near start
      );

      console.log('[Review] Found USER tags at start:', userTags.length);

      if (userTags.length > 0) {
        // Strategy 1: Find mentioned users' comments in ALL comments (including siblings)
        const mentionedUserIds = new Set(userTags.map(tag => tag.entityId));
        console.log('[Review] Mentioned user IDs:', Array.from(mentionedUserIds));

        const flaggedEpoch = parseInt(flaggedComment.createdAtEpoch) || Infinity;
        const mentionedComments = [];

        // Search ALL comments (not just parent chain) for mentioned users
        for (const comment of allComments) {
          if (mentionedUserIds.has(comment.authorUserId)) {
            const commentEpoch = parseInt(comment.createdAtEpoch) || 0;

            // Only include if posted before flagged comment
            if (commentEpoch <= flaggedEpoch) {
              mentionedComments.push(comment);
            }
          }
        }

        if (mentionedComments.length > 0) {
          console.log('[Review] Found mentioned users in all comments:', mentionedComments.length);

          // For each mentioned user, keep only their most recent comment
          const userToMostRecentComment = new Map();

          for (const comment of mentionedComments) {
            const existingComment = userToMostRecentComment.get(comment.authorUserId);
            if (!existingComment) {
              userToMostRecentComment.set(comment.authorUserId, comment);
            } else {
              const existingEpoch = parseInt(existingComment.createdAtEpoch) || 0;
              const currentEpoch = parseInt(comment.createdAtEpoch) || 0;
              if (currentEpoch > existingEpoch) {
                userToMostRecentComment.set(comment.authorUserId, comment);
              }
            }
          }

          const uniqueMentionedComments = Array.from(userToMostRecentComment.values());

          // Sort by timestamp (chronological order)
          uniqueMentionedComments.sort((a, b) => {
            const epochA = parseInt(a.createdAtEpoch) || 0;
            const epochB = parseInt(b.createdAtEpoch) || 0;
            return epochA - epochB;
          });

          // Filter out mentioned comments that are already in parent thread (avoid duplicates)
          const parentThreadIds = new Set(parentThread.map(c => c.id));
          const newMentionedComments = uniqueMentionedComments.filter(c => !parentThreadIds.has(c.id));

          // Build thread: [parent chain, new mentioned comments, flagged comment]
          const smartThread = [...parentThread, ...newMentionedComments, flaggedComment];

          console.log('[Review] Smart thread structure (Strategy 1 - with siblings):',
            smartThread.map(c => `${c.author} (depth ${c.depth})`).join(' → '));

          return smartThread;
        } else {
          console.log('[Review] No matching mentioned users found in all comments');
        }
      }

      // Strategy 2 (fallback): No USER tags or no matches - include direct parent only
      console.log('[Review] Using fallback strategy: direct parent only');

      // Find direct parent (comment at depth N-1 where N is flagged comment's depth)
      const directParent = parentThread
        .filter(msg => msg.depth !== -1)  // Exclude original post
        .slice(-1)[0];  // Get last comment in chain (immediate parent)

      if (directParent) {
        const smartThread = [originalPost, directParent, flaggedComment];
        console.log('[Review] Built fallback thread:', smartThread.length, 'messages');
        console.log('[Review] Thread structure:', smartThread.map(m => `${m.author} (depth: ${m.depth})`).join(' → '));
        return smartThread;
      }

      // Last resort: just original post + flagged comment
      console.log('[Review] Last resort: original post + flagged comment only');
      return [originalPost, flaggedComment];
    }

    // Start recursive search from top-level comments
    // Include the original post in the conversation thread
    const originalPostContext = {
      id: post.id,
      legacyId: feedItem.legacyAnalyticsId,
      content: originalPost.content,
      author: originalPost.author,
      authorUrl: originalPost.authorUrl,
      authorUserId: post.author?.user?.id || null,  // Store user ID for consistency
      createdAt: originalPost.createdAt,
      createdAtEpoch: post.createdAt?.epochMillis || null,  // Store timestamp
      depth: -1, // Mark as original post (before comments)
      isOriginalPost: true,
      tags: post.tags || [],  // Store tags array for consistency
    };

    // Initialize allComments collection with original post
    const allComments = [originalPostContext];

    const topLevelComments = post.comments?.pagedComments?.edges || [];
    findFlaggedCommentsRecursive(topLevelComments, [originalPostContext], 0, allComments);

    // Determine what is flagged
    const validation = {
      hasOriginalPost: !!originalPost.content || originalPost.hasMedia, // Accept posts with media even if no text
      hasTextContent: !!originalPost.content,
      hasMediaOnly: originalPost.hasMedia && !originalPost.content,
      hasVideos: originalPost.videoCount > 0,
      postIsFlagged: moderationInfo.hasModerationSummary,
      hasFlaggedComments: flaggedComments.length > 0,
      flaggedCount: (moderationInfo.hasModerationSummary ? 1 : 0) + flaggedComments.length,
      multipleFlags: (moderationInfo.hasModerationSummary ? 1 : 0) + flaggedComments.length > 1,
    };

    // Determine flagged content (prioritize post, then first comment)
    let flaggedContent = null;
    if (validation.postIsFlagged) {
      flaggedContent = {
        type: 'post',
        ...originalPost,
        moderationSummary: moderationInfo.moderationSummary,
        moderationDetails: moderationDetails,
      };
    } else if (flaggedComments.length > 0) {
      flaggedContent = {
        type: 'comment',
        ...flaggedComments[0],
      };
    }

    return {
      success: true,
      data: {
        url: pageUrl,
        originalPost,
        flaggedContent,
        flaggedComments,
        moderationInfo,
        validation,
        rawFeedItem: feedItem,
        extractedAt: new Date().toISOString(),
      },
    };

  } catch (error) {
    console.error('[Review] Error extracting data:', error);
    return {
      success: false,
      error: `Error parsing API data: ${error.message}`,
    };
  }
}

export function initReview() {
  const statusEl = document.getElementById('rv-status');
  const gate = document.getElementById('rv-gate');
  const gateInner = document.getElementById('rv-gate-inner');
  const content = document.getElementById('rv-content');
  const voteFooterEl = document.getElementById('rv-vote-footer');

  let trackedTabId = null;
  let trackedTabUrl = '';
  let onModerationFeed = false;
  let reviewing = false;   // whether the moderation-review UI is currently rendered
  // True only between a ModerationFeed request starting and its response landing.
  // Defaults to false so a panel opened long after the capture is never stuck
  // disabled waiting for a broadcast that will never come.
  let feedLoading = false;

  // #rv-content is the scrolling element (flex:1 + overflow-y:auto). New output —
  // the analysis card, chat answers — is appended at the bottom, which in a panel
  // this narrow routinely lands below the fold, so follow it down. rAF lets the
  // just-inserted HTML lay out before we measure scrollHeight.
  function scrollToBottom() {
    requestAnimationFrame(() => {
      content.scrollTo({ top: content.scrollHeight, behavior: 'smooth' });
    });
  }

  function showGate(html) {
    reviewing = false;
    content.hidden = true;
    voteFooterEl.hidden = true;
    voteFooterEl.innerHTML = '';
    gate.hidden = false;
    gateInner.innerHTML = html;
  }

  function showNotOnFeed() {
    statusEl.textContent = 'Not on moderation feed';
    showGate(`
      <button id="rv-goto-feed-btn" class="sp-btn sp-btn-primary">Take me to moderation feed</button>
      <p>Open the reported-content queue to start moderating.</p>
    `);
    document.getElementById('rv-goto-feed-btn')?.addEventListener('click', async () => {
      if (trackedTabId == null) return;
      await browser.tabs.update(trackedTabId, { url: 'https://nextdoor.com/moderation_feed/' });
    });
  }

  function showReadyToModerate() {
    statusEl.textContent = feedLoading ? 'Loading…' : 'Ready';
    showGate(`
      <button id="rv-moderate-btn" class="sp-btn sp-btn-primary" ${feedLoading ? 'disabled' : ''}>Moderate reply/post</button>
      <p>${feedLoading ? 'Waiting for the reported item to load…' : 'Loads this reported item into the review below.'}</p>
    `);
    document.getElementById('rv-moderate-btn')?.addEventListener('click', () => moderateCurrentItem());
  }

  // capturedApiData is a plain Map in the service worker (background.js) — never
  // persisted — so once the worker has been suspended there is simply no data for
  // this tab, and no message can conjure it back. Replaying the /ModerationFeed
  // request is the only way to re-capture it, which means reloading the page.
  function showNeedsReload() {
    statusEl.textContent = 'No captured data';
    showGate(`
      <button id="rv-reload-btn" class="sp-btn sp-btn-primary">Reload page</button>
      <p>Nothing was captured for this tab — the extension's background worker restarts when idle and its capture is memory-only. Reloading Nextdoor re-captures the reported item.</p>
    `);
    document.getElementById('rv-reload-btn')?.addEventListener('click', async () => {
      if (trackedTabId == null) return;
      await browser.tabs.reload(trackedTabId);
    });
  }

  // Bumped on every load attempt so a slower in-flight one can tell it has been
  // superseded. A click could only ever produce one at a time; auto-loading can
  // stack them if Next is hit twice quickly.
  let moderateSeq = 0;

  // `auto` marks a load triggered by data landing rather than by a click. The
  // load path is identical either way — only failure differs: an auto attempt
  // against an empty cache (cold service worker) is an expected miss, so it
  // falls back to the button instead of painting an error nobody asked for.
  async function moderateCurrentItem(auto = false) {
    if (trackedTabId == null) return;
    const mySeq = ++moderateSeq;
    statusEl.textContent = 'Loading…';
    const resp = await browser.runtime.sendMessage({ action: 'getModerationFeedData', tabId: trackedTabId }).catch(() => null);
    if (mySeq !== moderateSeq) return;
    const result = extractModerationData(resp?.data || null, trackedTabUrl);
    if (!result.success) {
      // An auto attempt can lose a harmless race — navigating onto the feed fires
      // refresh() before the page has even issued its request — and moderationDataReady
      // will drive the render a moment later, so leave the button rather than
      // alarming anyone. A click, having been asked for explicitly, reports what
      // it found: nothing captured at all is the recoverable case (offer the
      // reload), anything else is a genuine extraction failure.
      if (auto) { showReadyToModerate(); return; }
      if (!resp?.data) { showNeedsReload(); return; }
      showGate(`<p style="color:#c62828;"><strong>${result.error}</strong></p>`);
      statusEl.textContent = 'Error';
      return;
    }
    reviewing = true;
    gate.hidden = true;
    content.hidden = false;
    await renderReview(result.data, mySeq);
  }

  async function renderReview(data, seq = moderateSeq) {
    const { originalPost, flaggedContent, validation } = data;
    const postId = flaggedContent?.id || flaggedContent?.legacyId || originalPost.id || originalPost.legacyId;
    const savedReview = await loadPostReview(postId);
    // Storage read is the one await between the seq check in moderateCurrentItem
    // and the DOM writes below — bail if a newer item started rendering during it.
    if (seq !== moderateSeq) return;

    statusEl.textContent = flaggedContent?.type === 'post' ? 'Reviewing post'
      : flaggedContent?.type === 'comment' ? 'Reviewing reply'
      : 'No flagged content';

    let contentHTML = '';
    if (validation.hasMediaOnly) {
      contentHTML += `<div class="rv-warning"><strong>Media-Only Post:</strong> This post contains ${originalPost.mediaCount} ${originalPost.mediaTypes.toLowerCase()} but no text.<br><br><strong>Required:</strong> You MUST describe the media content in the "Additional Context" field below before analyzing.</div>`;
    } else if (!validation.hasOriginalPost) {
      contentHTML += `<div class="rv-warning"><strong>Error:</strong> Could not find original post content or media</div>`;
    }
    if (!validation.postIsFlagged && !validation.hasFlaggedComments) {
      contentHTML += `<div class="rv-warning"><strong>Error:</strong> No flagged content found</div>`;
    }

    if (validation.hasOriginalPost && (validation.postIsFlagged || validation.hasFlaggedComments)) {
      const multipleWarning = validation.multipleFlags
        ? `<div class="rv-warning"><strong>Warning:</strong> Multiple items flagged. Analyzing first one only.</div>`
        : '';

      contentHTML = `
        ${multipleWarning}
        <div class="rv-section">
          <h4 class="rv-section-title">Original Post</h4>
          <div class="rv-meta"><strong>${originalPost.author}</strong></div>
          <div class="rv-meta rv-meta-sub">${originalPost.createdAt} &bull; ${originalPost.neighborhood}</div>
          <div class="rv-card">${originalPost.content.trim()}${renderImageAttachments(originalPost.imageUrls, !!originalPost.content)}</div>
        </div>

        ${flaggedContent.conversationThread?.length > 0 ? formatConversationThread(flaggedContent.conversationThread) : ''}

        <div class="rv-section">
          <h4 class="rv-section-title">Flagged Content</h4>
          ${flaggedContent.type === 'post' ? `
            <div class="rv-flagged-banner">Original post is flagged</div>
          ` : `
            <div class="rv-meta"><strong>${flaggedContent.author}</strong></div>
            <div class="rv-meta rv-meta-sub">${flaggedContent.createdAt}${flaggedContent.depth !== undefined ? ` &bull; Depth: ${flaggedContent.depth}` : ''}</div>
            <div class="rv-card">${(flaggedContent.content || '').trim()}${renderImageAttachments(flaggedContent.imageUrls, !!flaggedContent.content)}${!flaggedContent.content && !(flaggedContent.imageUrls?.length > 0) ? '<span style="color:#9ca3af; font-style:italic; font-size:13px;">(no text content)</span>' : ''}</div>
          `}
          ${formatModerationDetails(flaggedContent.moderationDetails)}
        </div>
      `;
    }

    content.innerHTML = `
      ${contentHTML}
      <div class="rv-analyze-block">
        <div class="rv-context-row">
          <label for="rv-additional-context" class="rv-context-label">
            Additional Context ${(validation.hasMediaOnly || validation.hasVideos) ? '<span style="color:#dc2626;">*</span>' : '(optional)'}
          </label>
          <button id="rv-clear-context-btn" class="rv-clear-btn" style="display:${savedReview?.additionalContext ? 'inline-block' : 'none'};">Clear</button>
        </div>
        <textarea id="rv-additional-context" class="rv-context-textarea" placeholder="${validation.hasVideos ? 'REQUIRED: Describe the video content shown in this post...' : validation.hasMediaOnly ? 'REQUIRED: Describe the image/video/media content shown in this post...' : 'Describe images, videos, links, or other context not visible in the text'}"></textarea>
        ${validation.hasVideos ? `<div class="rv-context-note rv-context-required">This field is REQUIRED — this post contains video that cannot be sent to the AI.</div>`
          : validation.hasMediaOnly ? `<div class="rv-context-note rv-context-required">This field is REQUIRED because the post has no text content.</div>`
          : `<div class="rv-context-note">This context will be included in the LLM analysis.</div>`}
        <div class="rv-analyze-row">
          <button id="rv-analyze-btn" class="sp-btn sp-btn-primary" style="max-width:200px;">Analyze with AI</button>
          <label class="rv-thread-toggle-label">
            <input type="checkbox" id="rv-include-thread-ctx" checked>
            Include thread context
          </label>
        </div>
        <div id="rv-analysis-container"></div>
      </div>
      <div class="rv-qa-section">
        <div id="rv-qa-history" class="rv-qa-history"></div>
        <div class="pp-chat-inputrow">
          <textarea id="rv-qa-input" rows="1" placeholder="Ask about this post…"></textarea>
          <button id="rv-qa-send">Ask</button>
        </div>
      </div>
      <div class="rv-copyall-row">
        <button id="rv-copyall-btn" class="rv-clear-btn">Copy All</button>
      </div>
    `;
    attachThreadToggleHandlers(content);
    attachImageClickHandlers(content);

    const additionalContextTextarea = document.getElementById('rv-additional-context');
    if (savedReview?.additionalContext && additionalContextTextarea) {
      additionalContextTextarea.value = savedReview.additionalContext;
    }
    additionalContextTextarea?.addEventListener('input', () => {
      const clearBtnEl = document.getElementById('rv-clear-context-btn');
      if (clearBtnEl) clearBtnEl.style.display = additionalContextTextarea.value.trim() ? 'inline-block' : 'none';
    });
    document.getElementById('rv-clear-context-btn')?.addEventListener('click', async () => {
      if (additionalContextTextarea) additionalContextTextarea.value = '';
      document.getElementById('rv-clear-context-btn').style.display = 'none';
      // Clears THIS field only. It used to delete the whole saved record, which
      // now would take the analysis and the entire Q&A conversation with it —
      // a button labelled for one textarea shouldn't destroy unrelated work.
      // Only drop the record entirely when nothing else is left in it.
      const html = analysisContainer?.innerHTML || '';
      if (!html && qaLog.length === 0) await clearPostReview(postId);
      else await persistReview();
    });

    const analysisContainer = document.getElementById('rv-analysis-container');
    const analyzeBtn = document.getElementById('rv-analyze-btn');

    // The saved record is replaced wholesale, so every write must carry the full
    // state. The old blur handler saved only context+html, which silently dropped
    // analysisText and left the vote footer unable to restore on the next visit.
    let currentAnalysisText = savedReview?.analysisText || '';
    let qaLog = Array.isArray(savedReview?.qaLog) ? savedReview.qaLog.slice() : [];

    async function persistReview() {
      const ctx = additionalContextTextarea?.value.trim() || '';
      const html = analysisContainer?.innerHTML || '';
      if (!ctx && !html && qaLog.length === 0) return;
      await savePostReview(postId, {
        additionalContext: ctx,
        analysisHtml: html,
        analysisText: currentAnalysisText,
        qaLog,
      });
    }
    additionalContextTextarea?.addEventListener('blur', persistReview);

    if (savedReview?.analysisHtml) {
      analysisContainer.innerHTML = savedReview.analysisHtml;
      analysisContainer.querySelectorAll('[data-copy-text]').forEach(btn => {
        btn.addEventListener('click', () => copyWithFeedback(btn, btn.dataset.copyText));
      });
      analyzeBtn.textContent = 'Re-analyze';
      if (savedReview.analysisText) {
        renderVoteFooter(savedReview.analysisText);
      }
    }

    analyzeBtn.addEventListener('click', async () => {
      const additionalContext = additionalContextTextarea?.value.trim() || '';
      if ((validation.hasMediaOnly || validation.hasVideos) && !additionalContext) {
        const msg = validation.hasVideos
          ? 'Additional Context is required for posts with video. Please describe what the video shows.'
          : 'Additional Context is required for media-only posts. Please describe the content of the image/video/media.';
        analysisContainer.innerHTML = `<div class="rv-error-box"><strong>Error:</strong> ${msg}</div>`;
        additionalContextTextarea.style.borderColor = '#f44336';
        additionalContextTextarea.focus();
        return;
      }

      analyzeBtn.disabled = true;
      analysisContainer.innerHTML = `<div class="rv-loading">Analyzing…</div>`;
      scrollToBottom();

      const includeThread = document.getElementById('rv-include-thread-ctx')?.checked ?? true;
      try {
        const resp = await browser.runtime.sendMessage({
          action: 'analyzeContent',
          data: {
            originalPost: data.originalPost,
            flaggedContent: data.flaggedContent,
            conversationThread: includeThread ? (data.flaggedContent?.conversationThread || []) : [],
            additionalContext,
            imageUrls: data.flaggedContent?.imageUrls?.length > 0
              ? data.flaggedContent.imageUrls
              : (data.originalPost?.imageUrls || []),
          },
        });

        if (!resp?.success) {
          analysisContainer.innerHTML = `<div class="rv-error-box">${resp?.error || 'Analysis failed'}</div>`;
          scrollToBottom();
          return;
        }

        const styledAnalysisText = styleVoteSuggestion(resp.analysis.analysisText);
        const formattedAnalysis = formatAIAnalysis(styledAnalysisText);
        const voteRaw = (resp.analysis.analysisText.match(/\*\*Vote Suggestion:\*\*\s*(Keep|Remove|Maybe Remove)/i) || [])[1]?.toLowerCase();
        const voteCard = {
          keep: { border: '#16a34a', bg: '#f0fdf4', badge: '#166534', badgeBg: '#dcfce7', emoji: '✓', label: 'Keep' },
          remove: { border: '#dc2626', bg: '#fef2f2', badge: '#991b1b', badgeBg: '#fee2e2', emoji: '✗', label: 'Remove' },
          'maybe remove': { border: '#d97706', bg: '#fffbeb', badge: '#92400e', badgeBg: '#fef3c7', emoji: '−', label: 'Maybe Remove' },
        }[voteRaw] || { border: '#6b7280', bg: '#f9fafb', badge: '#374151', badgeBg: '#f3f4f6', emoji: '?', label: 'Unknown' };

        analysisContainer.innerHTML = `
          <div style="border:2px solid ${voteCard.border}; border-radius:10px; overflow:hidden; margin-top:12px;">
            <div style="background:${voteCard.badgeBg}; padding:12px 16px; display:flex; align-items:center; gap:10px; border-bottom:1px solid ${voteCard.border}33;">
              <span style="font-size:22px; font-weight:800; color:${voteCard.badge};">${voteCard.emoji}</span>
              <span style="font-size:17px; font-weight:700; color:${voteCard.badge}; letter-spacing:-0.01em;">${voteCard.label}</span>
            </div>
            <div style="background:${voteCard.bg}; padding:16px; font-size:13px; color:#1f2937; line-height:1.65;">
              ${formattedAnalysis}
            </div>
          </div>
        `;
        analysisContainer.querySelectorAll('[data-copy-text]').forEach(btn => {
          btn.addEventListener('click', () => copyWithFeedback(btn, btn.dataset.copyText));
        });

        currentAnalysisText = resp.analysis.analysisText;
        await persistReview();

        renderVoteFooter(resp.analysis.analysisText);
        scrollToBottom();
      } catch (err) {
        analysisContainer.innerHTML = `<div class="rv-error-box">${err.message}</div>`;
        scrollToBottom();
      } finally {
        analyzeBtn.disabled = false;
        analyzeBtn.textContent = 'Re-analyze';
      }
    });

    // Q&A
    const qaInput = document.getElementById('rv-qa-input');
    const qaSendBtn = document.getElementById('rv-qa-send');
    const qaHistory = document.getElementById('rv-qa-history');

    qaInput?.addEventListener('input', () => {
      qaInput.style.height = 'auto';
      qaInput.style.height = Math.min(qaInput.scrollHeight, 160) + 'px';
    });
    qaInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); qaSendBtn?.click(); }
    });

    function addQaBubble(text, isUser) {
      const div = document.createElement('div');
      div.className = isUser ? 'pp-bubble pp-bubble-user' : 'pp-bubble pp-bubble-assistant';
      if (isUser) div.textContent = text; else div.innerHTML = formatAIAnalysis(text);
      qaHistory.appendChild(div);
      scrollToBottom();
      return div;
    }

    // Renders a raw assistant answer into a bubble: formatted text plus, when the
    // model proposed a different vote, a pill with a working Apply button. Shared
    // so a restored conversation is indistinguishable from a live one — storing
    // rendered HTML instead would bring back the markup but leave Apply dead.
    function renderAssistantAnswer(bubble, answer) {
      const revisedMatch = answer.match(/\*\*Revised:\s*(Keep|Maybe Remove|Remove)\s*[—\-]\s*(.+?)\*\*/i);
      const mainText = answer.replace(/\*\*Revised:.*?\*\*/i, '').trim();
      bubble.innerHTML = formatAIAnalysis(mainText);
      if (!revisedMatch) return;
      const vote = revisedMatch[1];
      const comment = revisedMatch[2].trim();
      const pill = document.createElement('div');
      pill.className = 'rv-revised-pill';
      pill.innerHTML = `<div><strong>Revised: ${vote}</strong> — ${comment}</div>`;
      const applyBtn = document.createElement('button');
      applyBtn.textContent = '↳ Apply to vote';
      applyBtn.className = 'rv-apply-btn';
      applyBtn.addEventListener('click', () => {
        applyRevisedVote(vote, comment);
        applyBtn.textContent = '✓ Applied to vote';
        applyBtn.disabled = true;
      });
      pill.appendChild(applyBtn);
      bubble.appendChild(pill);
    }

    // Replay a previously saved conversation for this post.
    qaLog.forEach(entry => {
      if (entry.role === 'user') {
        addQaBubble(entry.content, true);
      } else {
        const bubble = addQaBubble('', false);
        renderAssistantAnswer(bubble, entry.content);
      }
    });

    function applyRevisedVote(vote, comment) {
      const pillBtn = voteFooterEl.querySelector(`.rv-vote-pill[data-vote="${vote.toLowerCase()}"]`);
      if (!pillBtn) return;
      if (voteFooterEl._voteComments) voteFooterEl._voteComments[vote.toLowerCase()] = comment;
      pillBtn.click();
      voteFooterEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    qaSendBtn?.addEventListener('click', async () => {
      const question = qaInput?.value?.trim();
      if (!question || qaSendBtn.disabled) return;

      // Snapshot PRIOR turns before appending this one. The old version read the
      // DOM after adding the new bubbles, so it sent the current question twice
      // (once in history, once as `question`) plus the "…" placeholder as a fake
      // assistant turn.
      const history = qaLog.map(e => ({ role: e.role, content: e.content }));

      addQaBubble(question, true);
      qaInput.value = '';
      qaInput.style.height = 'auto';
      qaSendBtn.disabled = true;
      qaSendBtn.textContent = '…';
      const typingBubble = addQaBubble('…', false);

      const analysisText = analysisContainer?.innerText?.trim() || '';

      try {
        const resp = await browser.runtime.sendMessage({
          action: 'askAboutPost',
          question,
          reviewData: data,
          analysisText,
          history,
        });
        const answer = resp?.answer || 'No response.';
        renderAssistantAnswer(typingBubble, answer);
        qaLog.push({ role: 'user', content: question });
        qaLog.push({ role: 'assistant', content: answer });
        await persistReview();
      } catch (err) {
        typingBubble.textContent = 'Error: ' + err.message;
        typingBubble.classList.add('pp-bubble-error');
      }

      qaSendBtn.disabled = false;
      qaSendBtn.textContent = 'Ask';
      scrollToBottom();
    });

    // Copy All
    document.getElementById('rv-copyall-btn')?.addEventListener('click', () => {
      const lines = [];
      lines.push('=== ORIGINAL POST ===');
      lines.push(`Author: ${originalPost?.author || 'Unknown'}`);
      if (originalPost?.createdAt) lines.push(`Posted: ${originalPost.createdAt}`);
      lines.push(originalPost?.content || '(no text)');
      if (originalPost?.imageUrls?.length > 0) originalPost.imageUrls.forEach(url => lines.push(`[Image: ${url}]`));

      const thread = flaggedContent?.conversationThread;
      if (thread?.length > 0) {
        lines.push('');
        lines.push('=== CONVERSATION THREAD ===');
        thread.forEach(c => lines.push(`${'  '.repeat(c.depth || 0)}[${c.author}]: ${c.content}`));
      }

      lines.push('');
      lines.push('=== FLAGGED CONTENT ===');
      if (flaggedContent?.type === 'post') {
        lines.push('(Original post is flagged)');
      } else {
        lines.push(`Author: ${flaggedContent?.author || 'Unknown'}`);
        if (flaggedContent?.createdAt) lines.push(`Posted: ${flaggedContent.createdAt}`);
        lines.push(flaggedContent?.content || '(no text)');
      }

      const isVoteTotalsNoise = (text) => {
        const matches = [...(text || '').matchAll(/\*\s*(\d+)/g)];
        return matches.length >= 1 && matches.length <= 3;
      };
      const voteLabelMap = { keep: 'Keep', remove: 'Remove', abstain: 'Maybe Remove', report: 'Report' };
      const mod = flaggedContent?.moderationDetails;

      if (mod?.totalReports > 0 || mod?.reports?.length > 0) {
        lines.push('');
        lines.push(`=== REPORTS (${mod.totalReports} total) ===`);
        mod.reports.forEach(r => {
          if (r.type === 'title') { if (r.text !== 'Vote totals') lines.push(`-- ${r.text} --`); }
          else if (r.type === 'description') lines.push(r.text);
          else if (r.type === 'section') { if (!isVoteTotalsNoise(r.text)) lines.push(`-- ${r.text} --`); }
          else if (r.type === 'row') { if (!isVoteTotalsNoise(`${r.reason || ''} ${r.count || ''}`)) lines.push(`${r.reason}: ${r.count}`); }
          else if (r.type === 'individual_report') {
            let line = `[${voteLabelMap[r.voteType] || r.voteType}] ${r.reporterName}${r.locationTime ? ` (${r.locationTime})` : ''}`;
            if (r.reportType) line += ` — ${r.reportType}`;
            lines.push(line);
            if (r.additionalNote) lines.push(`  "${r.additionalNote}"`);
          }
        });
      }

      if (mod?.totalVotes > 0 || mod?.votes?.length > 0) {
        lines.push('');
        lines.push(`=== COMMUNITY VOTES (${mod.totalVotes} total) ===`);
        mod.votes.forEach(v => {
          if (v.type === 'section') lines.push(`-- ${v.text} --`);
          else if (v.type === 'row') lines.push(`${v.reason}: ${v.count}`);
          else if (v.type === 'individual_vote') {
            let line = `[${voteLabelMap[v.voteType] || v.voteType}] ${v.voterName}${v.locationTime ? ` (${v.locationTime})` : ''}`;
            lines.push(line);
            if (v.additionalNote) lines.push(`  "${v.additionalNote}"`);
          }
        });
      }

      if (mod?.totalNotes > 0) {
        lines.push('');
        lines.push(`=== MODERATOR NOTES (${mod.totalNotes} total) ===`);
        mod.notes.forEach((n, i) => lines.push(`${i + 1}. ${n.text}`));
      }

      const ctx = additionalContextTextarea?.value?.trim();
      if (ctx) { lines.push(''); lines.push('=== ADDITIONAL CONTEXT ==='); lines.push(ctx); }

      const analysisText = analysisContainer?.innerText?.trim();
      if (analysisText) { lines.push(''); lines.push('=== AI ANALYSIS ==='); lines.push(analysisText); }

      const withHardBreaks = lines.join('\n').split('\n').map(l => l.length ? l + '  ' : l).join('\n');
      copyWithFeedback(document.getElementById('rv-copyall-btn'), withHardBreaks, 'Copy All');
    });
  }

  function renderVoteFooter(analysisText) {
    const voteMatch = analysisText.match(/\*\*Vote Suggestion:\*\*\s*(Keep|Remove|Maybe Remove)/i);
    const vote = (voteMatch?.[1] || 'keep').toLowerCase();
    const commentMatch = analysisText.match(/\*\*Comment Suggestion:\*\*\s*(.+?)(?:\n|$)/is);
    const commentText = commentMatch?.[1]?.trim() || '';

    const voteConfig = {
      'keep': { label: '✓ Keep', dark: '#166534' },
      'maybe remove': { label: '− Maybe Remove', dark: '#374151' },
      'remove': { label: '✗ Remove', dark: '#991b1b' },
    };
    const pillStyle = (v, selected) => {
      const dark = voteConfig[v].dark;
      return `flex:1; padding:10px 6px; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; font-family:inherit; border:2px solid ${dark}; background:${selected ? dark : 'white'}; color:${selected ? 'white' : dark};`;
    };

    voteFooterEl.innerHTML = `
      <div style="display:flex; gap:8px; margin-bottom:12px;">
        ${Object.entries(voteConfig).map(([v, cfg]) =>
          `<button class="rv-vote-pill" data-vote="${v}" style="${pillStyle(v, v === vote)}">${cfg.label}</button>`
        ).join('')}
      </div>
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
        <span style="font-size:11px; font-weight:600; color:#6b7280; text-transform:uppercase; letter-spacing:0.05em;">Comment</span>
        <button id="rv-variations-btn" class="pp-icon-btn">🎲 Variations</button>
      </div>
      <textarea id="rv-vote-comment" rows="2" class="rv-context-textarea">${commentText}</textarea>
      <div id="rv-variations-list" style="display:none; margin-bottom:10px; border:1px solid #e5e7eb; border-radius:8px; overflow:hidden;"></div>
      <button id="rv-submit-vote" class="sp-btn sp-btn-primary">Copy Comment</button>
      <div style="margin-top:10px; padding:9px 11px; background:#f3f4f6; border-radius:7px; font-size:11.5px; color:#4b5563; line-height:1.5;">Copy the comment, then cast your <strong>${voteConfig[vote].label.replace(/^[^ ]+ /, '')}</strong> vote directly on Nextdoor and paste the comment into its note field.</div>
      <div id="rv-vote-error" style="display:none; color:#c62828; font-size:12px; margin-top:8px; text-align:center;"></div>
    `;
    voteFooterEl.hidden = false;

    let selectedVote = vote;
    const voteComments = { [vote]: commentText };
    voteFooterEl._voteComments = voteComments;

    const variationsBtn = voteFooterEl.querySelector('#rv-variations-btn');
    const variationsList = voteFooterEl.querySelector('#rv-variations-list');
    const commentTextarea = voteFooterEl.querySelector('#rv-vote-comment');
    if (variationsBtn) variationsBtn.disabled = !commentText.trim();

    commentTextarea?.addEventListener('input', () => {
      voteComments[selectedVote] = commentTextarea.value;
      if (variationsBtn) variationsBtn.disabled = !commentTextarea.value.trim();
    });

    voteFooterEl.querySelectorAll('.rv-vote-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedVote = btn.dataset.vote;
        voteFooterEl.querySelectorAll('.rv-vote-pill').forEach(b => {
          b.style.cssText = pillStyle(b.dataset.vote, b.dataset.vote === selectedVote);
        });
        if (commentTextarea) commentTextarea.value = voteComments[selectedVote] ?? '';
        if (variationsBtn) variationsBtn.disabled = !commentTextarea?.value?.trim();
        if (variationsList) variationsList.style.display = 'none';
      });
    });

    variationsBtn?.addEventListener('click', async () => {
      if (variationsList.style.display !== 'none') {
        variationsList.style.display = 'none';
        variationsBtn.textContent = '🎲 Variations';
        return;
      }
      variationsBtn.textContent = '⏳ Generating...';
      variationsBtn.disabled = true;
      try {
        const resp = await browser.runtime.sendMessage({
          action: 'generateCommentVariations',
          currentComment: commentTextarea?.value?.trim() || '',
          vote: selectedVote,
        });
        if (resp?.success && resp.variations?.length) {
          variationsList.innerHTML = resp.variations.map((v, i) =>
            `<button class="rv-var-item" data-idx="${i}">${v}</button>`
          ).join('');
          variationsList.style.display = 'block';
          variationsList.querySelectorAll('.rv-var-item').forEach(btn => {
            btn.addEventListener('click', () => {
              if (commentTextarea) commentTextarea.value = btn.textContent;
              variationsList.style.display = 'none';
              variationsBtn.textContent = '🎲 Variations';
            });
          });
        } else {
          variationsList.innerHTML = `<div style="padding:10px 12px; font-size:12px; color:#6b7280;">${resp?.error || 'No variations returned'}</div>`;
          variationsList.style.display = 'block';
        }
      } catch (err) {
        variationsList.innerHTML = `<div style="padding:10px 12px; font-size:12px; color:#c62828;">Error: ${err.message}</div>`;
        variationsList.style.display = 'block';
      }
      variationsBtn.textContent = '🎲 Variations';
      variationsBtn.disabled = false;
    });

    voteFooterEl.querySelector('#rv-submit-vote').addEventListener('click', async () => {
      const submitBtn = voteFooterEl.querySelector('#rv-submit-vote');
      const errorDiv = voteFooterEl.querySelector('#rv-vote-error');
      const comment = voteFooterEl.querySelector('#rv-vote-comment')?.value?.trim() || '';
      errorDiv.style.display = 'none';
      if (await copyToClipboard(comment)) {
        submitBtn.textContent = '✓ Copied — vote on Nextdoor';
        submitBtn.disabled = true;
        setTimeout(() => { submitBtn.textContent = 'Copy Comment'; submitBtn.disabled = false; }, 1800);
      } else {
        errorDiv.textContent = 'Copy failed — select the comment text and copy it manually.';
        errorDiv.style.display = 'block';
      }
    });
  }

  async function findActiveNextdoorTab() {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (tab?.url && /^https:\/\/([^/]+\.)?nextdoor\.com\//.test(tab.url)) {
      return { tabId: tab.id, url: tab.url, isOnFeed: tab.url.includes('/moderation_feed') };
    }
    return { tabId: null, url: '', isOnFeed: false };
  }

  let refreshSeq = 0;
  async function refresh() {
    const mySeq = ++refreshSeq;
    const { tabId, url, isOnFeed } = await findActiveNextdoorTab();
    if (mySeq !== refreshSeq) return;
    if (tabId != null) { trackedTabId = tabId; trackedTabUrl = url; }
    onModerationFeed = isOnFeed;

    if (reviewing) return; // don't clobber an in-progress review on an unrelated tab-focus event
    if (!onModerationFeed) { showNotOnFeed(); return; }
    // Load it rather than offering a button: rendering reads the already-captured
    // GraphQL data and costs nothing — the LLM is only touched by "Analyze with
    // AI". Falls back to the button when the cache has nothing for this tab.
    moderateCurrentItem(true);
  }

  // Auto-load means the "Moderate reply/post" button is normally skipped, so ↻ is
  // how a moderator forces a reload of the item already on screen. Re-rendering
  // restores that post's saved analysis and Q&A, so nothing is lost.
  // No refresh control here on purpose. Next/Previous each issue a real
  // /ModerationFeed request (nothing is served from the browser's own cache), so
  // the captured payload is always current for the item on screen — there is
  // nothing staler for a button to re-fetch.
  browser.tabs.onActivated.addListener(refresh);

  // Authoritative for the tracked tab's OWN url: unlike refresh() (which is
  // opportunistic and deliberately won't clobber an in-progress review just
  // because focus moved to some other/no tab), this fires only when the exact
  // tab being reviewed navigates — including SPA pushState nav, which Chrome
  // still reports via changeInfo.url with no full load cycle. "Reviewing"
  // only makes sense while that tab is actually on /moderation_feed/, so this
  // always resyncs, even mid-review.
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tabId !== trackedTabId) return;
    if (!changeInfo.url && changeInfo.status !== 'complete') return;
    if (tab?.url) trackedTabUrl = tab.url;
    const isOnFeed = !!tab?.url && tab.url.includes('/moderation_feed');
    onModerationFeed = isOnFeed;
    if (!isOnFeed) { showNotOnFeed(); return; }
    if (reviewing) return; // still on moderation_feed — Next/Previous is handled via the broadcast below
    showReadyToModerate();
  });

  // moderationFeedLoading fires when the moderator moves to the next/previous
  // reported item (confirmed live that Next/Previous always issues a genuine new
  // /ModerationFeed request), and moderationDataReady when that item's data has
  // landed — which is exactly when it can be rendered. Clearing to the gate on
  // the loading edge first keeps the previous item's review from lingering under
  // the new one. Rendering is free; "Analyze with AI" still needs a click, so a
  // new item never spends an LLM call on its own.
  browser.runtime.onMessage.addListener((message) => {
    if (message.tabId == null || message.tabId !== trackedTabId) return;
    if (message.action === 'moderationFeedLoading') {
      feedLoading = true;
      if (onModerationFeed) showReadyToModerate();
    } else if (message.action === 'moderationDataReady') {
      feedLoading = false;
      if (onModerationFeed && !reviewing) moderateCurrentItem(true);
    }
  });

  refresh();
}
