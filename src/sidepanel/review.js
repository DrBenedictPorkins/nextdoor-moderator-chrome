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
  showImageLightbox,
} from './format.js';

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

// Wraps the first half of `text`'s words (capped at `maxCount`) in spans the
// "brush sweep" load animation can target, leaving whitespace and the rest of
// the text untouched.
function wrapSweepWords(text, maxCount = 30) {
  const totalWords = (text.match(/\S+/g) || []).length;
  const count = Math.min(maxCount, Math.ceil(totalWords * 0.5));
  let wordIndex = 0;
  return text.split(/(\s+)/).map(token => {
    if (token === '' || /^\s+$/.test(token) || wordIndex >= count) return token;
    wordIndex++;
    return `<span class="rv-sweep-word">${token}</span>`;
  }).join('');
}

// Sweeps a highlight across the wrapped words in sequence — each one snaps to
// full highlight then eases back over SWEEP_FADE_MS (CSS `rv-sweep-pulse`),
// and the next word starts before the previous has finished fading, giving
// the effect of a brush passing over the text rather than a one-at-a-time
// blink. The card's border lights up for the whole pass and fades out once
// the last word is done, so it reads as one continuous stroke.
const SWEEP_STAGGER_MS = 220;
const SWEEP_FADE_MS = 2400;

function playSweepAnimation(container) {
  const words = container.querySelectorAll('.rv-sweep-word');
  if (!words.length) return;

  words.forEach((el, i) => {
    setTimeout(() => {
      el.classList.add('rv-sweep-hit');
      setTimeout(() => el.classList.remove('rv-sweep-hit'), SWEEP_FADE_MS);
    }, i * SWEEP_STAGGER_MS);
  });

  const card = container.querySelector('.rv-card');
  if (!card) return;
  card.classList.add('rv-sweep-border');
  const totalMs = (words.length - 1) * SWEEP_STAGGER_MS + SWEEP_FADE_MS;
  setTimeout(() => {
    card.classList.add('rv-sweep-border-fading');
    card.classList.remove('rv-sweep-border');
    setTimeout(() => card.classList.remove('rv-sweep-border-fading'), 1000);
  }, totalMs);
}

/**
 * Extract moderation data from the raw captured /ModerationFeed GraphQL response.
 * Ported verbatim from content-api.js's extractModerationData(), except it now
 * takes the raw response as a parameter instead of reading a content-script-local
 * module variable — the side panel pulls it directly from background's
 * capturedApiData via the getModerationFeedData action.
 */
function extractModerationData(moderationFeedData, pageUrl = '') {
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

    // Nextdoor's FeedItem is a union: FeedItemPost, FeedItemComment,
    // FeedItemTopLineComment, FeedItemClassified, VideoFeedItem. All but
    // FeedItemTopLineComment carry the parent `post`; that one carries only the
    // comment, so there is no thread to render around it.
    if (!post) {
      return {
        success: false,
        error: `No post data found in feed item (${feedItem.__typename || 'unknown type'})`,
      };
    }

    // On a comment report the reported comment now hangs off the feed item
    // itself (FeedItemComment.comment) instead of only being discoverable by its
    // own moderationSummaryV3 inside post.comments.pagedComments.
    const reportedComment = feedItem.comment || null;
    const reportedCommentId = reportedComment?.id || null;

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

    // Extract moderation info with details.
    // moderationSummaryV3 used to live only on post.moderationInfo. Every
    // concrete FeedItem type now implements ModeratableFeedItem, which carries
    // `moderationInfo: ContentModerationInfo!` on the feed item as well, so read
    // both. The field was not renamed — moderationSummaryV3 is still the current
    // one on ContentModerationInfo (there is no V4; V2 and the legacy
    // moderationSummary are the only others).
    //
    // A feed-item summary on a comment report describes the COMMENT, not the
    // post, so it must not be promoted into a post flag.
    const feedItemSummary = feedItem.moderationInfo?.moderationSummaryV3 || null;
    const postSummary = post.moderationInfo?.moderationSummaryV3
      || (reportedComment ? null : feedItemSummary)
      || null;
    const moderationInfo = {
      hasModerationSummary: !!postSummary,
      moderationSummary: postSummary,
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

        // Flagged either by its own summary, or by being the comment this feed
        // item is a report of (the summary then sits on the feed item).
        const commentSummary = comment.moderationInfo?.moderationSummaryV3
          || (comment.id === reportedCommentId ? feedItemSummary : null);
        if (commentSummary) {
          const commentModerationDetails = parseModerationSummary(commentSummary);

          // Build smart minimal conversation thread based on tags
          const smartThread = buildSmartConversationThread(commentData, parentThread, allComments);

          flaggedComments.push({
            ...commentData,
            moderationSummary: commentSummary,
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

      if (userTags.length > 0) {
        // Strategy 1: Find mentioned users' comments in ALL comments (including siblings)
        const mentionedUserIds = new Set(userTags.map(tag => tag.entityId));

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
          return smartThread;
        }
      }

      // Strategy 2 (fallback): No USER tags or no matches - include direct parent only
      // Find direct parent (comment at depth N-1 where N is flagged comment's depth)
      const directParent = parentThread
        .filter(msg => msg.depth !== -1)  // Exclude original post
        .slice(-1)[0];  // Get last comment in chain (immediate parent)

      if (directParent) {
        return [originalPost, directParent, flaggedComment];
      }

      // Last resort: just original post + flagged comment
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

    // The reported comment is not guaranteed to be inside the page of comments
    // the feed response carries — a reply buried in a 90-comment thread routinely
    // is not. If the walk above missed it, take it straight off the feed item so
    // the report still renders, with whatever context we do have.
    if (reportedCommentId && !flaggedComments.some(c => c.id === reportedCommentId)) {
      const c = reportedComment;
      const summary = c.moderationInfo?.moderationSummaryV3 || feedItemSummary;
      const commentData = {
        id: c.id,
        legacyId: c.legacyCommentId,
        content: c.styledBody?.text || c.body || '',
        author: c.author?.displayName || 'Unknown',
        authorUrl: c.author?.url || '',
        authorUserId: c.author?.user?.id || null,
        createdAt: c.createdAt?.asDateTime?.relativeTime || '',
        createdAtEpoch: c.createdAt?.epochMillis || null,
        depth: 0,
        tags: c.tags || [],
        imageUrls: (c.mediaAttachments || []).filter(m => m.type === 'PHOTO').map(m => m.url).filter(Boolean),
        detectedBusiness: c.detectedBusiness ?? null,
        authorType: c.author?.type ?? c.author?.authorType ?? null,
      };
      flaggedComments.push({
        ...commentData,
        moderationSummary: summary,
        moderationDetails: summary ? parseModerationSummary(summary) : null,
        conversationThread: [originalPostContext, commentData],
      });
    }

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

    // Everything in the moderation feed is there because it was reported, so a
    // feed item that parses but carries no flag anywhere is not a normal state —
    // it means Nextdoor moved the field again. Log the shape so the next break is
    // diagnosable without re-probing the schema. (Nextdoor has done this once
    // already: moderationInfo was hoisted from post onto the feed item when
    // FeedItem became a union.)
    if (!validation.postIsFlagged && !validation.hasFlaggedComments) {
      console.warn(
        '[Review] SHAPE CHANGE? Feed item parsed but nothing is flagged.',
        {
          feedItemType: feedItem.__typename || null,
          feedItemKeys: Object.keys(feedItem || {}),
          feedItemModerationInfoKeys: Object.keys(feedItem.moderationInfo || {}),
          postModerationInfoKeys: Object.keys(post.moderationInfo || {}),
          hasFeedItemComment: !!feedItem.comment,
          commentsReturned: (post.comments?.pagedComments?.edges || []).length,
          postId: post.id,
        }
      );
    }

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
    await renderReview(result.data);
  }

  // Nothing about a review — analysis, Q&A, additional context, captured
  // screenshots — is persisted. Moving to a different item (Next/Previous, or
  // reopening one already reviewed) always starts blank; this was a deliberate
  // simplification once screenshots were added to Additional Context, since
  // persisting captured images per post would risk chrome.storage.local's quota
  // and made "which post am I looking at" harder to reason about.
  async function renderReview(data) {
    const { originalPost, flaggedContent, validation } = data;
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
          <div class="rv-card">${wrapSweepWords(originalPost.content.trim())}${renderImageAttachments(originalPost.imageUrls, !!originalPost.content)}</div>
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
            Additional Context <span id="rv-context-required-mark" style="color:#dc2626; display:${(validation.hasMediaOnly || validation.hasVideos) ? 'inline' : 'none'};">*</span>${(validation.hasMediaOnly || validation.hasVideos) ? '' : ' (optional)'}
          </label>
          <div class="rv-context-actions">
            <button id="rv-capture-btn" type="button" class="rv-clear-btn">📷 Capture</button>
            <button id="rv-clear-context-btn" type="button" class="rv-clear-btn" style="display:none;">Clear</button>
          </div>
        </div>
        <div class="rv-context-input-wrap">
          <div id="rv-context-images" class="rv-context-images"></div>
          <textarea id="rv-additional-context" class="rv-context-textarea" placeholder="${(validation.hasVideos || validation.hasMediaOnly) ? 'Describe it in text, capture a screenshot below, or both...' : 'Describe images, videos, links, or other context not visible in the text'}"></textarea>
        </div>
        <div id="rv-capture-error" class="rv-context-note rv-context-required" hidden></div>
        ${(validation.hasVideos || validation.hasMediaOnly)
          ? `<div id="rv-context-required-note" class="rv-context-note rv-context-required"></div>`
          : `<div class="rv-context-note">This context (and any captured snapshots) will be included in the LLM analysis.</div>`}
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
    playSweepAnimation(content);

    const additionalContextTextarea = document.getElementById('rv-additional-context');
    const requiresContext = validation.hasMediaOnly || validation.hasVideos;

    // The requirement is text OR a captured screenshot, not text specifically —
    // reflect whichever is actually still missing instead of always demanding
    // text, and clear the "required" styling the moment either is provided.
    function syncContextRequirement() {
      if (!requiresContext) return;
      const satisfied = !!additionalContextTextarea?.value.trim() || contextImages.length > 0;
      const mark = document.getElementById('rv-context-required-mark');
      const note = document.getElementById('rv-context-required-note');
      if (mark) mark.style.display = satisfied ? 'none' : 'inline';
      if (!note) return;
      note.classList.toggle('rv-context-required', !satisfied);
      const why = validation.hasVideos
        ? "this post contains video that can't be sent to the AI as-is"
        : 'this post has no text content';
      note.textContent = satisfied
        ? '✓ Requirement met — this context will be included in the LLM analysis.'
        : `Required (${why}): a text description, a captured screenshot, or both.`;
    }

    additionalContextTextarea?.addEventListener('input', () => {
      const clearBtnEl = document.getElementById('rv-clear-context-btn');
      if (clearBtnEl) clearBtnEl.style.display = additionalContextTextarea.value.trim() ? 'inline-block' : 'none';
      syncContextRequirement();
    });

    // Screenshots captured via "Capture" — in-memory only for this render pass,
    // same as everything else in the review; see the note above renderReview.
    let contextImages = [];
    syncContextRequirement(); // populate the required-note text on first render

    function renderContextImages() {
      const wrap = document.getElementById('rv-context-images');
      if (!wrap) return;
      wrap.innerHTML = contextImages.map((src, i) => `
        <div class="rv-context-thumb">
          <img src="${src}" alt="Captured region ${i + 1}" data-idx="${i}">
          <button type="button" class="rv-context-thumb-remove" data-idx="${i}" title="Remove">×</button>
        </div>
      `).join('');
      wrap.querySelectorAll('.rv-context-thumb img').forEach(img => {
        img.addEventListener('click', () => showImageLightbox(contextImages[Number(img.dataset.idx)]));
      });
      wrap.querySelectorAll('.rv-context-thumb-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          contextImages.splice(Number(btn.dataset.idx), 1);
          renderContextImages();
          syncClearButton();
          syncContextRequirement();
        });
      });
      // The thumbnail strip sits inside the textarea's own box (overlaid on top,
      // not a separate element below it) — push typed text down below it so the
      // two don't overlap.
      if (additionalContextTextarea) {
        additionalContextTextarea.style.paddingTop = contextImages.length > 0 ? '52px' : '';
      }
      syncContextRequirement();
    }

    function syncClearButton() {
      const clearBtnEl = document.getElementById('rv-clear-context-btn');
      if (!clearBtnEl) return;
      const hasContent = !!additionalContextTextarea?.value.trim() || contextImages.length > 0;
      clearBtnEl.style.display = hasContent ? 'inline-block' : 'none';
    }

    document.getElementById('rv-clear-context-btn')?.addEventListener('click', () => {
      if (additionalContextTextarea) additionalContextTextarea.value = '';
      contextImages = [];
      renderContextImages();
      syncClearButton();
    });

    const captureBtn = document.getElementById('rv-capture-btn');
    const captureLabel = captureBtn?.textContent || '📷 Capture';
    const captureErrorEl = document.getElementById('rv-capture-error');
    captureBtn?.addEventListener('click', async () => {
      if (trackedTabId == null) return;
      captureBtn.disabled = true;
      captureBtn.textContent = 'Select a region on the page…';
      if (captureErrorEl) { captureErrorEl.hidden = true; captureErrorEl.textContent = ''; }
      let resp;
      let sendError = null;
      try {
        resp = await browser.runtime.sendMessage({ action: 'startRegionCapture', tabId: trackedTabId });
      } catch (err) {
        sendError = err.message;
      }
      captureBtn.disabled = false;
      if (resp?.success && resp.dataUrl) {
        contextImages.push(resp.dataUrl);
        renderContextImages();
        syncClearButton();
        // Visible confirmation beyond the thumbnail appearing below — without
        // this a capture that succeeded looked identical to one that silently
        // failed (button just reverts to its idle label either way).
        captureBtn.textContent = `✓ Added (${contextImages.length})`;
        setTimeout(() => { captureBtn.textContent = captureLabel; }, 1500);
      } else if (resp?.cancelled) {
        captureBtn.textContent = captureLabel;
      } else {
        // Show the actual failure instead of a generic message — this is
        // returned by background.js's startRegionCapture handler (or thrown by
        // sendMessage itself, e.g. a stale content script after a reload), and
        // previously got thrown away here with nothing shown anywhere.
        const msg = sendError || resp?.error || 'Unknown error';
        captureBtn.textContent = '⚠ Capture failed';
        setTimeout(() => { captureBtn.textContent = captureLabel; }, 2000);
        if (captureErrorEl) { captureErrorEl.textContent = `Capture failed: ${msg}`; captureErrorEl.hidden = false; }
      }
    });

    const analysisContainer = document.getElementById('rv-analysis-container');
    const analyzeBtn = document.getElementById('rv-analyze-btn');
    let qaLog = [];

    analyzeBtn.addEventListener('click', async () => {
      const additionalContext = additionalContextTextarea?.value.trim() || '';
      if ((validation.hasMediaOnly || validation.hasVideos) && !additionalContext && contextImages.length === 0) {
        const msg = validation.hasVideos
          ? 'Additional Context is required for posts with video. Describe what it shows, or click "Capture" to snapshot a frame.'
          : 'Additional Context is required for media-only posts. Describe the content, or click "Capture" to snapshot it.';
        analysisContainer.innerHTML = `<div class="rv-error-box"><strong>Error:</strong> ${msg}</div>`;
        additionalContextTextarea.style.borderColor = '#f44336';
        additionalContextTextarea.focus();
        return;
      }

      analyzeBtn.disabled = true;
      analysisContainer.innerHTML = `<div class="rv-loading"><span class="rv-spinner"></span><span>Analyzing<span class="rv-loading-dots"><span>.</span><span>.</span><span>.</span></span></span></div>`;
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
            imageUrls: [
              ...(data.flaggedContent?.imageUrls?.length > 0
                ? data.flaggedContent.imageUrls
                : (data.originalPost?.imageUrls || [])),
              ...contextImages,
            ],
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
          imageUrls: contextImages,
        });
        const answer = resp?.answer || 'No response.';
        renderAssistantAnswer(typingBubble, answer);
        qaLog.push({ role: 'user', content: question });
        qaLog.push({ role: 'assistant', content: answer });
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
