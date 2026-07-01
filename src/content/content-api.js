/**
 * Content script for Nextdoor Moderator Extension
 * Uses API interception to capture moderation feed data
 */
import browser from 'webextension-polyfill';

console.log('[Nextdoor Moderator] Content script loaded (API mode)');

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

// Store the latest moderation feed data
let moderationFeedData = null;
let dataIsValid = false;

// --- Post review data persistence (7-day TTL) ---
const REVIEW_STORAGE_PREFIX = 'nd_review_';
const REVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getReviewStorageKey(postId) {
  return `${REVIEW_STORAGE_PREFIX}${postId}`;
}

async function savePostReview(postId, data) {
  if (!postId) return;
  const record = {
    ...data,
    savedAt: Date.now(),
    expiresAt: Date.now() + REVIEW_TTL_MS,
  };
  await browser.storage.local.set({ [getReviewStorageKey(postId)]: record });
}

async function loadPostReview(postId) {
  if (!postId) return null;
  const key = getReviewStorageKey(postId);
  const result = await browser.storage.local.get(key);
  const record = result[key];
  if (!record) return null;
  if (Date.now() > record.expiresAt) {
    await browser.storage.local.remove(key);
    return null;
  }
  return record;
}

async function clearPostReview(postId) {
  if (!postId) return;
  await browser.storage.local.remove(getReviewStorageKey(postId));
}

// Purge expired review records on load
(async function purgeExpiredReviews() {
  const all = await browser.storage.local.get(null);
  const expired = Object.keys(all).filter(k =>
    k.startsWith(REVIEW_STORAGE_PREFIX) && all[k].expiresAt && Date.now() > all[k].expiresAt
  );
  if (expired.length > 0) {
    await browser.storage.local.remove(expired);
    console.log(`[Nextdoor Moderator] Purged ${expired.length} expired review records`);
  }
})();

/**
 * Parse moderationSummaryV3 to extract human-readable details
 */
function parseModerationSummary(moderationSummary) {
  if (!moderationSummary) return null;

  const details = {
    type: moderationSummary.__typename || 'Unknown',
    reports: [],
    votes: [],
    notes: [],
    totalReports: 0,
    totalVotes: 0,
    totalNotes: 0,
  };

  // Extract report details
  const reportSummary = moderationSummary.reportModerationEventsSummary;
  if (reportSummary?.contents) {
    reportSummary.contents.forEach((content) => {
      if (content.type === 'ModerationContentRowMainTitle' && content.title?.text) {
        details.reports.push({
          type: 'title',
          text: content.title.text,
        });
      } else if (content.type === 'ModerationContentRowMainDescription' && content.description?.text) {
        details.reports.push({
          type: 'description',
          text: content.description.text,
        });
      } else if (content.type === 'ModerationContentRowSectionTitle' && content.text?.text) {
        details.reports.push({
          type: 'section',
          text: content.text.text,
        });
      } else if (content.type === 'ModerationContentRow' && content.leftText?.text) {
        // Extract report reason and count
        const leftText = content.leftText.text;
        const rightText = content.rightText?.text || '';
        details.reports.push({
          type: 'row',
          reason: leftText,
          count: rightText,
        });
      } else if (content.type === 'ModerationEventSummary') {
        // Individual reporter with report type
        const topText = content.topContent?.text?.text || '';
        const icon = content.leftContent?.icon?.icon || '';
        const bottomText = content.bottomContent?.text?.text || '';

        // Parse the text: "Name\nLocation • Time\n* Report Type ›"
        const lines = topText.split('\n');
        const reporterName = lines[0] || '';
        const locationTime = lines[1] || '';
        const reportType = lines[2] ? lines[2].replace(/^\*\s*/, '').replace(/\s*›\s*$/, '').trim() : '';

        details.reports.push({
          type: 'individual_report',
          reporterName,
          locationTime,
          reportType,
          additionalNote: bottomText,
          voteType: icon.includes('KEEP') ? 'keep' : icon.includes('REMOVE') ? 'remove' : icon.includes('NEUTRAL') ? 'abstain' : 'report',
        });
      }
    });
  }

  // Extract vote details
  const voteSummary = moderationSummary.voteModerationEventsSummary;
  if (voteSummary?.contents) {
    let isVoteTotalsSection = false;

    voteSummary.contents.forEach((content) => {
      // Debug logging for vote content
      console.log('[DEBUG] Vote content type:', content.type);
      console.log('[DEBUG] Vote content:', JSON.stringify(content, null, 2));

      // Check for section title indicating vote totals
      if (content.type === 'ModerationContentRowSectionTitle' && content.text?.text) {
        const sectionTitle = content.text.text.toLowerCase();
        if (sectionTitle.includes('vote total')) {
          isVoteTotalsSection = true;
          details.votes.push({
            type: 'section',
            text: content.text.text,
          });
        }
      } else if (content.type === 'ModerationContentRow' && content.leftText?.text) {
        const leftText = content.leftText.text;
        const rightText = content.rightText?.text || '';
        console.log('[DEBUG] Vote row - leftText:', leftText, 'rightText:', rightText, 'isVoteTotals:', isVoteTotalsSection);
        details.votes.push({
          type: 'row',
          reason: leftText,
          count: rightText,
          isVoteTotals: isVoteTotalsSection,
        });
      } else if (content.type === 'ModerationEventSummary') {
        // Individual voter
        isVoteTotalsSection = false; // Reset when we hit individual voters
        const topText = content.topContent?.text?.text || '';
        const icon = content.leftContent?.icon?.icon || '';
        const bottomText = content.bottomContent?.text?.text || '';

        const lines = topText.split('\n');
        const voterName = lines[0] || '';
        const locationTime = lines[1] || '';

        details.votes.push({
          type: 'individual_vote',
          voterName,
          locationTime,
          additionalNote: bottomText,
          voteType: icon.includes('KEEP') ? 'keep' : icon.includes('REMOVE') ? 'remove' : icon.includes('NEUTRAL') ? 'abstain' : 'unknown',
        });
      }
    });
  }

  // Extract notes
  const notesSummary = moderationSummary.addNotesModerationEventsSummary;
  if (notesSummary?.contents) {
    notesSummary.contents.forEach((content) => {
      if (content.type === 'ModerationContentRow' && content.leftText?.text) {
        details.notes.push({
          text: content.leftText.text,
        });
      }
    });
  }

  // Calculate totals from row counts AND individual reports
  const rowReportCount = details.reports
    .filter((r) => r.type === 'row' && r.count)
    .reduce((sum, r) => sum + (parseInt(r.count) || 0), 0);

  const individualReportCount = details.reports
    .filter((r) => r.type === 'individual_report')
    .length;

  details.totalReports = Math.max(rowReportCount, individualReportCount);

  const rowVoteCount = details.votes
    .filter((v) => v.type === 'row' && v.count)
    .reduce((sum, v) => sum + (parseInt(v.count) || 0), 0);

  const individualVoteCount = details.votes
    .filter((v) => v.type === 'individual_vote')
    .length;

  details.totalVotes = Math.max(rowVoteCount, individualVoteCount);

  details.totalNotes = details.notes.length;

  // Extract collapsed view text if available
  if (moderationSummary.leftText?.text) {
    details.collapsedLeftText = moderationSummary.leftText.text;
  }
  if (moderationSummary.rightText?.text) {
    details.collapsedRightText = moderationSummary.rightText.text;
  }

  return details;
}

/**
 * Extract moderation data from API response
 */
function extractModerationData() {
  console.log('[Content] extractModerationData() called');
  console.log('[Content] moderationFeedData exists:', !!moderationFeedData);
  console.log('[Content] moderationFeedData value:', moderationFeedData);

  if (!moderationFeedData) {
    console.error('[Content] No moderation feed data available');
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
    };

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
        };

        // Add this comment to the global collection for sibling search
        allComments.push(commentData);

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
      console.log('[Content] Building smart thread for flagged comment:', flaggedComment.id);
      console.log('[Content] Flagged comment tags:', JSON.stringify(flaggedComment.tags, null, 2));
      console.log('[Content] Parent thread length:', parentThread.length);
      console.log('[Content] All comments available for search:', allComments.length);

      // Always include original post (depth: -1)
      const originalPost = parentThread.find(msg => msg.depth === -1);
      if (!originalPost) {
        console.warn('[Content] No original post found in parent thread');
        return [flaggedComment];
      }

      // Analyze tags array for USER mentions at start of text
      const userTags = (flaggedComment.tags || []).filter(tag =>
        tag.type === 'USER' &&
        tag.startIndex !== undefined &&
        tag.startIndex < 20  // Mentioned at/near start
      );

      console.log('[Content] Found USER tags at start:', userTags.length);

      if (userTags.length > 0) {
        // Strategy 1: Find mentioned users' comments in ALL comments (including siblings)
        const mentionedUserIds = new Set(userTags.map(tag => tag.entityId));
        console.log('[Content] Mentioned user IDs:', Array.from(mentionedUserIds));

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
          console.log('[Content] Found mentioned users in all comments:', mentionedComments.length);

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

          console.log('[Content] Smart thread structure (Strategy 1 - with siblings):',
            smartThread.map(c => `${c.author} (depth ${c.depth})`).join(' → '));

          return smartThread;
        } else {
          console.log('[Content] No matching mentioned users found in all comments');
        }
      }

      // Strategy 2 (fallback): No USER tags or no matches - include direct parent only
      console.log('[Content] Using fallback strategy: direct parent only');

      // Find direct parent (comment at depth N-1 where N is flagged comment's depth)
      const directParent = parentThread
        .filter(msg => msg.depth !== -1)  // Exclude original post
        .slice(-1)[0];  // Get last comment in chain (immediate parent)

      if (directParent) {
        const smartThread = [originalPost, directParent, flaggedComment];
        console.log('[Content] Built fallback thread:', smartThread.length, 'messages');
        console.log('[Content] Thread structure:', smartThread.map(m => `${m.author} (depth: ${m.depth})`).join(' → '));
        return smartThread;
      }

      // Last resort: just original post + flagged comment
      console.log('[Content] Last resort: original post + flagged comment only');
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
        url: window.location.href,
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
    console.error('[Nextdoor Moderator] Error extracting data:', error);
    return {
      success: false,
      error: `Error parsing API data: ${error.message}`,
    };
  }
}

/**
 * Format AI analysis text with markdown-style formatting
 */
function formatAIAnalysis(text) {
  if (!text) return 'No analysis available';

  // Replace **bold** with <strong>
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Parse markdown tables
  text = text.replace(/((?:^\|.+\|\s*\n)+)/gm, (tableBlock) => {
    const rows = tableBlock.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return tableBlock;

    // Check if second row is a separator (|---|---|)
    const isSeparator = (row) => /^\|[\s\-:|]+\|$/.test(row.trim());
    const hasSeparator = rows.length >= 2 && isSeparator(rows[1]);

    let tableHtml = '<table style="width:100%; border-collapse:collapse; margin:12px 0; font-size:13px;">';

    rows.forEach((row, idx) => {
      if (hasSeparator && idx === 1) return; // skip separator row
      const cells = row.split('|').filter((_, i, arr) => i > 0 && i < arr.length - 1).map(c => c.trim());
      const isHeader = hasSeparator && idx === 0;
      const tag = isHeader ? 'th' : 'td';
      const bgStyle = isHeader ? 'background:#f0f0f0; font-weight:600;' : (idx % 2 === 0 ? 'background:#fafafa;' : '');
      tableHtml += '<tr>';
      cells.forEach(cell => {
        tableHtml += `<${tag} style="border:1px solid #ddd; padding:6px 8px; text-align:left; ${bgStyle}">${cell}</${tag}>`;
      });
      tableHtml += '</tr>';
    });

    tableHtml += '</table>';
    return tableHtml;
  });

  // Replace --- horizontal rules
  text = text.replace(/^---$/gm, '<hr style="border:none; border-top:1px solid #ddd; margin:12px 0;">');

  // Split into sections and format
  let html = '';
  const lines = text.split('\n');

  lines.forEach(line => {
    line = line.trim();
    if (!line) {
      html += '<br>';
      return;
    }

    // Skip if it's already an HTML element (from table parsing)
    if (line.startsWith('<table') || line.startsWith('<hr')) {
      html += line;
      return;
    }

    // Check if it's a bullet point
    if (line.startsWith('- ') || line.startsWith('* ')) {
      html += `<div style="margin-left: 20px; margin-bottom: 4px;">&bull; ${line.substring(2)}</div>`;
    }
    // Check if it's a copyable field (Comment Suggestion or Optional Note)
    else if (line.match(/^<strong>Comment Suggestion:<\/strong>/)) {
      const copyValue = line.replace(/<\/?strong>/g, '').replace(/^Comment Suggestion:\s*/, '').trim();
      const btnId = `copy-btn-${Math.random().toString(36).substring(2, 8)}`;
      html += `<div style="margin-top: 12px; margin-bottom: 4px; font-size: 15px; display: flex; align-items: baseline; gap: 8px;">
        <span>${line}</span>
        <button id="${btnId}" data-copy-text="${copyValue.replace(/"/g, '&quot;')}" style="background: none; border: 1px solid #d1d5db; border-radius: 5px; padding: 3px 8px; font-size: 11px; font-weight: 500; color: #6b7280; cursor: pointer; white-space: nowrap; flex-shrink: 0;" title="Copy to clipboard">Copy</button>
      </div>`;
    }
    // Check if it's a section header (contains strong tag at start)
    else if (line.match(/^<strong>[^<]+:<\/strong>/)) {
      html += `<div style="margin-top: 12px; margin-bottom: 4px; font-size: 15px;">${line}</div>`;
    }
    // Regular paragraph
    else {
      html += `<div style="margin-bottom: 4px;">${line}</div>`;
    }
  });

  return html;
}

/**
 * Format conversation thread for display in overlay
 */
function renderImageAttachments(imageUrls, hasText) {
  if (!imageUrls || imageUrls.length === 0) return '';
  const marginTop = hasText ? '10px' : '0';
  return imageUrls.slice(0, 3).map(url =>
    `<img src="${url}" style="max-width:240px; max-height:240px; object-fit:contain; border-radius:6px; margin-top:${marginTop}; display:block; cursor:pointer;" loading="lazy" onclick="window.open('${url}','_blank')">`
  ).join('');
}

function formatConversationThread(conversationThread) {
  if (!conversationThread || conversationThread.length === 0) {
    return '';
  }

  // Limit display to max 5 levels deep to avoid overwhelming UI
  const maxDisplay = 5;
  const displayThread = conversationThread.slice(-maxDisplay);
  const truncated = conversationThread.length > maxDisplay;

  const count = conversationThread.length;
  const label = `Conversation Thread (${count} message${count !== 1 ? 's' : ''})`;
  const truncatedNote = truncated ? `<span style="font-size:10px; color:#999; font-weight:400; margin-left:6px; font-style:italic;">showing last 5</span>` : '';

  let itemsHtml = '';
  displayThread.forEach((msg) => {
    const indent = Math.max(0, (msg.depth + 1) * 20);
    const depthIndicator = msg.depth >= 0 ? '→ '.repeat(Math.min(msg.depth + 1, 3)) : '';
    itemsHtml += `<div style="margin-bottom: 6px; margin-left: ${indent}px; background: white; border: 1px solid #e5e7eb; border-left: 3px solid #3b82f6; border-radius: 6px; padding: 10px 12px;">
      <div style="font-size: 11px; font-weight: 600; color: #374151; margin-bottom: 4px;">
        ${depthIndicator}<strong>${msg.author}</strong> <span style="color: #9ca3af; font-weight: 400;">${msg.createdAt}</span>
      </div>
      <div style="font-size: 12px; color: #4b5563; line-height: 1.5; margin-top: 4px;">
        ${msg.content ? `"${msg.content.length > 150 ? msg.content.substring(0, 150) + '...' : msg.content}"` : ''}
        ${renderImageAttachments(msg.imageUrls, !!msg.content)}
      </div>
    </div>`;
  });

  const html = `<div style="margin-bottom: 16px;">
    <button onclick="(function(btn){const body=btn.nextElementSibling;const collapsed=body.style.display==='none';body.style.display=collapsed?'block':'none';btn.querySelector('.nd-chevron').textContent=collapsed?'▾':'▸';})(this)" style="display:flex; align-items:center; gap:6px; background:none; border:none; padding:0; cursor:pointer; font-family:inherit; width:100%; text-align:left; margin-bottom:0;">
      <span class="nd-chevron" style="font-size:11px; color:#9ca3af;">▸</span>
      <h4 style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:#6b7280; margin:0;">${label}${truncatedNote}</h4>
    </button>
    <div style="display:none; margin-top:10px;">${itemsHtml}</div>
  </div>`;

  return html;
}

/**
 * Format moderation details for display in overlay
 */
function formatModerationDetails(moderationDetails) {
  if (!moderationDetails) {
    return '<div style="background: #f5f5f5; padding: 12px; border-radius: 4px; margin-top: 12px; font-size: 12px; color: #666;">No detailed moderation data available</div>';
  }

  let html = '<div style="margin-top: 12px; border-top: 1px solid #ddd; padding-top: 12px;">';

  // Reports section
  if (moderationDetails.totalReports > 0 || moderationDetails.reports.length > 0) {
    console.log('[DEBUG REPORTS] Total reports:', moderationDetails.totalReports);
    console.log('[DEBUG REPORTS] Reports array:', JSON.stringify(moderationDetails.reports, null, 2));

    // Calculate vote totals from actual reviewer data
    let keepCount = 0;
    let maybeRemoveCount = 0;
    let removeCount = 0;

    moderationDetails.reports.forEach((report) => {
      if (report.type === 'individual_report') {
        if (report.voteType === 'keep') keepCount++;
        else if (report.voteType === 'abstain') maybeRemoveCount++;
        else if (report.voteType === 'remove') removeCount++;
      }
    });

    html += `
      <div style="background: white; border: 1px solid #fee2e2; border-radius: 10px; padding: 12px; margin-bottom: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
        <div style="font-size: 13px; font-weight: 700; color: #991b1b; margin-bottom: 12px;">
          Reports Summary (${moderationDetails.totalReports} total)
        </div>
        <div style="font-size: 12px; color: #333;">
    `;

    // Display vote totals at the top (calculated from actual reviewers)
    const totalVotes = keepCount + maybeRemoveCount + removeCount;
    if (totalVotes > 0) {
      html += `
        <div style="display: flex; gap: 20px; padding: 12px 0; margin-bottom: 12px; border-bottom: 1px solid #f3f4f6;">
          <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 20px; padding: 6px 14px; display: inline-flex; align-items: center; gap: 6px;">
            <span style="color: #166534; font-size: 16px; font-weight: bold;">✓</span>
            <span style="font-weight: 600; color: #166534; font-size: 13px;">Keep: ${keepCount}</span>
          </div>
          <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 20px; padding: 6px 14px; display: inline-flex; align-items: center; gap: 6px;">
            <span style="color: #374151; font-size: 16px; font-weight: bold;">−</span>
            <span style="font-weight: 600; color: #374151; font-size: 13px;">Maybe remove: ${maybeRemoveCount}</span>
          </div>
          <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 20px; padding: 6px 14px; display: inline-flex; align-items: center; gap: 6px;">
            <span style="color: #991b1b; font-size: 16px; font-weight: bold;">✗</span>
            <span style="font-weight: 600; color: #991b1b; font-size: 13px;">Remove: ${removeCount}</span>
          </div>
        </div>
      `;
    }

    moderationDetails.reports.forEach((report) => {
      console.log('[DEBUG REPORTS] Processing report:', report.type, 'reason:', report.reason, 'count:', report.count);
      if (report.type === 'title') {
        // Skip "Vote totals" title since we're displaying it above
        if (report.text !== 'Vote totals') {
          html += `<div style="font-weight: bold; margin-bottom: 4px;">${report.text}</div>`;
        }
      } else if (report.type === 'description') {
        html += `<div style="margin-bottom: 4px; color: #666;">${report.text}</div>`;
      } else if (report.type === 'section') {
        // Skip vote totals section - we're calculating it from actual reviewer data
        const sectionText = report.text || '';
        const bulletPattern = /\*\s*(\d+)/g;
        const matches = [...sectionText.matchAll(bulletPattern)];

        // If this looks like vote totals (has asterisk + numbers), skip it
        if (matches.length >= 1 && matches.length <= 3) {
          // Skip - we're displaying calculated vote totals above
        } else {
          // Regular section text
          html += `<div style="margin-top: 8px; margin-bottom: 4px; font-weight: 600; color: #d32f2f;">${report.text}</div>`;
        }
      } else if (report.type === 'row') {
        // Skip vote totals rows - we're calculating from actual reviewer data
        const reasonText = report.reason || '';
        const countText = report.count || '';
        const combinedText = reasonText + ' ' + countText;
        const bulletPattern = /\*\s*(\d+)/g;
        const matches = [...combinedText.matchAll(bulletPattern)];

        // If this looks like vote totals, skip it
        if (matches.length >= 1 && matches.length <= 3) {
          // Skip - we're displaying calculated vote totals above
        } else {
          // Regular report row - display as-is
          html += `<div style="display: flex; justify-content: space-between; margin-bottom: 2px; padding: 4px; background: rgba(255,255,255,0.5); border-radius: 2px;">
            <span>${report.reason}</span>
            <span style="font-weight: bold; color: #c62828;">${report.count}</span>
          </div>`;
        }
      } else if (report.type === 'individual_report') {
        // Determine icon and color based on voteType
        let voteIcon = '';
        let voteColor = '';
        let voteLabel = '';

        let voteBg = '';
        if (report.voteType === 'keep') {
          voteIcon = '✓';
          voteColor = '#166534';
          voteBg = '#dcfce7';
          voteLabel = 'Keep';
        } else if (report.voteType === 'remove') {
          voteIcon = '✗';
          voteColor = '#991b1b';
          voteBg = '#fee2e2';
          voteLabel = 'Remove';
        } else if (report.voteType === 'abstain') {
          voteIcon = '−';
          voteColor = '#374151';
          voteBg = '#f3f4f6';
          voteLabel = 'Maybe remove';
        } else if (report.voteType === 'report') {
          voteIcon = '🚩';
          voteColor = '#c2410c';
          voteBg = '#fff7ed';
          voteLabel = 'Report';
        } else {
          voteIcon = '−';
          voteColor = '#374151';
          voteBg = '#f3f4f6';
          voteLabel = 'Maybe remove';
        }

        html += `
          <div style="display: flex; align-items: center; gap: 8px; padding: 8px; background: #fafafa; border-radius: 8px; border: 1px solid #f3f4f6; margin: 4px 0;">
            <div style="width: 28px; height: 28px; border-radius: 50%; background: ${voteBg}; color: ${voteColor}; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 14px; flex-shrink: 0;">
              ${voteIcon}
            </div>
            <div style="flex: 1; min-width: 0;">
              <div style="font-size: 13px; font-weight: 600; color: #111827;">${report.reporterName}</div>
              <div style="font-size: 11px; color: #9ca3af;">${report.locationTime}</div>
              ${report.reportType ? `<div style="font-size: 11px; color: #dc2626; font-weight: 500; background: #fef2f2; padding: 2px 8px; border-radius: 4px; display: inline-block; margin-top: 3px;">→ ${report.reportType}</div>` : ''}
              ${report.additionalNote ? `<div style="font-size: 12px; color: #555; margin-top: 4px; font-style: italic; background: #fff; padding: 4px 8px; border-radius: 3px; border-left: 2px solid ${voteColor};">"${report.additionalNote}"</div>` : ''}
            </div>
            <div style="font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 12px; background: ${voteBg}; color: ${voteColor}; flex-shrink: 0;">
              ${voteLabel}
            </div>
          </div>
        `;
      }
    });

    html += `</div></div>`;
  }

  // Votes section
  if (moderationDetails.totalVotes > 0 || moderationDetails.votes.length > 0) {
    html += `
      <div style="background: white; border: 1px solid #dbeafe; border-radius: 10px; padding: 12px; margin-bottom: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
        <div style="font-size: 13px; font-weight: 700; color: #1e40af; margin-bottom: 12px;">
          Community Votes (${moderationDetails.totalVotes} total)
        </div>
        <div style="font-size: 12px; color: #333;">
    `;

    // Process vote rows first (these may contain vote totals)
    const voteRows = moderationDetails.votes.filter(v => v.type === 'row');
    const individualVotes = moderationDetails.votes.filter(v => v.type === 'individual_vote');

    console.log('[DEBUG RENDER] voteRows:', JSON.stringify(voteRows, null, 2));
    console.log('[DEBUG RENDER] individualVotes:', individualVotes.length);

    // Check if we have vote totals to display
    if (voteRows.length > 0) {
      // Try to parse vote totals from the text
      // Look for patterns like "* 8   * 5" or vote type labels
      let keepCount = 0;
      let abstainCount = 0;
      let removeCount = 0;
      let hasVoteTotals = false;

      voteRows.forEach((vote) => {
        const text = vote.reason || '';
        console.log('[DEBUG RENDER] Processing vote row - reason:', vote.reason, 'count:', vote.count, 'isVoteTotals:', vote.isVoteTotals);

        // Check if this row is marked as part of vote totals section
        if (vote.isVoteTotals) {
          hasVoteTotals = true;
          // Parse the vote type and count
          const count = parseInt(vote.count) || 0;
          if (text.includes('Keep') || text.includes('keep')) {
            keepCount = count;
          } else if (text.includes('Remove') || text.includes('remove')) {
            removeCount = count;
          } else if (text.includes('Abstain') || text.includes('abstain') || text.includes('Maybe')) {
            abstainCount = count;
          }
        }
      });

      // If we couldn't parse structured data, try to extract from bullet points
      if (!hasVoteTotals) {
        voteRows.forEach((vote) => {
          const reasonText = vote.reason || '';
          const countText = vote.count || '';

          // Try to parse patterns like "* 6 * 2 * 8" in BOTH count and reason fields
          const bulletPattern = /\*\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/;
          const bulletMatchCount = countText.match(bulletPattern);
          const bulletMatchReason = reasonText.match(bulletPattern);

          const bulletMatch = bulletMatchCount || bulletMatchReason;

          if (bulletMatch) {
            console.log('[DEBUG RENDER] Matched bullet pattern:', bulletMatch[0]);
            console.log('[DEBUG RENDER] Extracted values - Keep:', bulletMatch[1], 'Abstain:', bulletMatch[2], 'Remove:', bulletMatch[3]);
            // Assuming order: Keep, Abstain, Remove (based on Nextdoor's typical order)
            keepCount = parseInt(bulletMatch[1]) || 0;
            abstainCount = parseInt(bulletMatch[2]) || 0;
            removeCount = parseInt(bulletMatch[3]) || 0;
            hasVoteTotals = true;
          }
        });
      }

      // Display vote totals section title if it exists
      const voteTotalsSection = moderationDetails.votes.find(v => v.type === 'section');
      if (voteTotalsSection) {
        html += `<div style="font-weight: 600; color: #1976d2; margin-bottom: 8px; font-size: 13px;">${voteTotalsSection.text}</div>`;
      }

      // Display vote totals with color-coded icons
      if (hasVoteTotals || keepCount > 0 || abstainCount > 0 || removeCount > 0) {
        html += `
          <div style="display: flex; gap: 20px; padding: 12px 0; margin-bottom: 12px; border-bottom: 1px solid #f3f4f6;">
            <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 20px; padding: 6px 14px; display: inline-flex; align-items: center; gap: 6px;">
              <span style="color: #166534; font-size: 16px; font-weight: bold;">✓</span>
              <span style="font-weight: 600; color: #166534; font-size: 13px;">Keep: ${keepCount}</span>
            </div>
            <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 20px; padding: 6px 14px; display: inline-flex; align-items: center; gap: 6px;">
              <span style="color: #374151; font-size: 16px; font-weight: bold;">−</span>
              <span style="font-weight: 600; color: #374151; font-size: 13px;">Abstain: ${abstainCount}</span>
            </div>
            <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 20px; padding: 6px 14px; display: inline-flex; align-items: center; gap: 6px;">
              <span style="color: #991b1b; font-size: 16px; font-weight: bold;">✗</span>
              <span style="font-weight: 600; color: #991b1b; font-size: 13px;">Remove: ${removeCount}</span>
            </div>
          </div>
        `;
      }
    }

    // Display individual votes with prominent circular icons
    individualVotes.forEach((vote) => {
      let voteIcon = '';
      let voteColor = '';
      let voteLabel = '';

      let voteBgV = '';
      if (vote.voteType === 'keep') {
        voteIcon = '✓';
        voteColor = '#166534';
        voteBgV = '#dcfce7';
        voteLabel = 'Keep';
      } else if (vote.voteType === 'remove') {
        voteIcon = '✗';
        voteColor = '#991b1b';
        voteBgV = '#fee2e2';
        voteLabel = 'Remove';
      } else {
        voteIcon = '−';
        voteColor = '#374151';
        voteBgV = '#f3f4f6';
        voteLabel = 'Abstain';
      }

      html += `
        <div style="display: flex; align-items: center; gap: 8px; padding: 8px; background: #fafafa; border-radius: 8px; border: 1px solid #f3f4f6; margin: 4px 0;">
          <div style="width: 28px; height: 28px; border-radius: 50%; background: ${voteBgV}; color: ${voteColor}; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 14px; flex-shrink: 0;">
            ${voteIcon}
          </div>
          <div style="flex: 1; min-width: 0;">
            <div style="font-size: 13px; font-weight: 600; color: #111827;">${vote.voterName}</div>
            <div style="font-size: 11px; color: #9ca3af;">${vote.locationTime}</div>
            ${vote.additionalNote ? `<div style="font-size: 12px; color: #555; margin-top: 4px; font-style: italic; background: #fff; padding: 4px 8px; border-radius: 3px; border-left: 2px solid ${voteColor};">"${vote.additionalNote}"</div>` : ''}
          </div>
          <div style="font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 12px; background: ${voteBgV}; color: ${voteColor}; flex-shrink: 0;">
            ${voteLabel}
          </div>
        </div>
      `;
    });

    html += `</div></div>`;
  }

  // Notes section
  if (moderationDetails.totalNotes > 0) {
    html += `
      <div style="background: #fff3e0; padding: 12px; border-radius: 4px; margin-bottom: 8px;">
        <div style="font-weight: bold; color: #f57c00; margin-bottom: 8px; font-size: 14px;">
          📝 Moderator Notes (${moderationDetails.totalNotes} total)
        </div>
        <div style="font-size: 12px; color: #333;">
    `;

    moderationDetails.notes.forEach((note, idx) => {
      html += `<div style="margin-bottom: 4px; padding: 4px; background: rgba(255,255,255,0.5); border-radius: 2px;">
        ${idx + 1}. ${note.text}
      </div>`;
    });

    html += `</div></div>`;
  }

  // Collapsed view fallback
  if (moderationDetails.collapsedLeftText || moderationDetails.collapsedRightText) {
    html += `
      <div style="background: #f5f5f5; padding: 12px; border-radius: 4px; font-size: 12px; color: #666;">
        ${moderationDetails.collapsedLeftText ? `<div><strong>Summary:</strong> ${moderationDetails.collapsedLeftText}</div>` : ''}
        ${moderationDetails.collapsedRightText ? `<div><strong>Count:</strong> ${moderationDetails.collapsedRightText}</div>` : ''}
      </div>
    `;
  }

  html += '</div>';
  return html;
}

/**
 * Create Phase 1: Content Display Overlay
 */
async function createContentOverlay(result) {
  if (!result.success) {
    showErrorOverlay(result.error);
    return;
  }

  const { data } = result;
  const { originalPost, flaggedContent, validation } = data;
  const postId = flaggedContent?.id || flaggedContent?.legacyId || originalPost.id || originalPost.legacyId;

  // Load any saved review data for this post
  const savedReview = await loadPostReview(postId);

  // Remove any existing overlays
  const existingBackdrop = document.getElementById('nextdoor-moderator-backdrop');
  const existingOverlay = document.getElementById('nextdoor-moderator-overlay');
  existingBackdrop?.remove();
  existingOverlay?.remove();

  // Create backdrop
  const backdrop = document.createElement('div');
  backdrop.id = 'nextdoor-moderator-backdrop';
  backdrop.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.5);
    z-index: 9999;
    backdrop-filter: blur(2px);
  `;

  // Create overlay content
  const overlay = document.createElement('div');
  overlay.id = 'nextdoor-moderator-overlay';
  overlay.dataset.postId = postId || '';
  overlay.dataset.reviewData = JSON.stringify(data);

  // Load saved size or use defaults
  const savedSize = await browser.storage.local.get('overlaySize');
  const overlayW = savedSize.overlaySize?.width || 600;
  const overlayH = savedSize.overlaySize?.height || null;

  // Outer shell: fixed position, holds resize handle
  overlay.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(${overlayW}px, calc(100vw - 40px));
    ${overlayH ? `height: min(${overlayH}px, calc(100vh - 40px));` : 'max-height: calc(100vh - 40px);'}
    background: white;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 12px;
    box-shadow: 0 24px 64px rgba(0,0,0,0.35), 0 8px 24px rgba(0,0,0,0.2);
    z-index: 10000;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
  `;

  // Inner scrollable content wrapper
  const scrollWrapper = document.createElement('div');
  scrollWrapper.id = 'nextdoor-moderator-scroll';
  scrollWrapper.style.cssText = `
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    min-height: 0;
    background: #f8fafc;
    border-radius: 0 0 12px 12px;
  `;

  // Resize handle - stays visible at bottom-right corner
  const resizeHandle = document.createElement('div');
  resizeHandle.style.cssText = `
    position: absolute;
    bottom: 2px;
    right: 2px;
    width: 18px;
    height: 18px;
    cursor: nwse-resize;
    z-index: 10001;
    background: linear-gradient(135deg, transparent 50%, #999 50%, transparent 55%, #999 60%, transparent 65%, #999 70%);
    opacity: 0.5;
    border-radius: 0 0 6px 0;
  `;
  resizeHandle.addEventListener('mouseenter', () => { resizeHandle.style.opacity = '1'; });
  resizeHandle.addEventListener('mouseleave', () => { resizeHandle.style.opacity = '0.5'; });
  overlay.appendChild(resizeHandle);

  let resizing = false, rStartX, rStartY, rStartW, rStartH;
  resizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    resizing = true;
    rStartX = e.clientX;
    rStartY = e.clientY;
    rStartW = overlay.offsetWidth;
    rStartH = overlay.offsetHeight;
    overlay.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const dx = e.clientX - rStartX;
    const dy = e.clientY - rStartY;
    const newW = Math.max(400, Math.min(window.innerWidth - 40, rStartW + dx * 2));
    const newH = Math.max(300, Math.min(window.innerHeight - 40, rStartH + dy * 2));
    overlay.style.width = newW + 'px';
    overlay.style.height = newH + 'px';
    overlay.style.maxHeight = 'none';
  });
  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    overlay.style.userSelect = '';
    browser.storage.local.set({
      overlaySize: { width: overlay.offsetWidth, height: overlay.offsetHeight }
    });
  });

  // Clamp overlay within viewport on window resize
  const clampOverlayToViewport = () => {
    const maxW = window.innerWidth - 40;
    const maxH = window.innerHeight - 40;
    const curW = overlay.offsetWidth;
    const curH = overlay.offsetHeight;
    if (curW > maxW) { overlay.style.width = maxW + 'px'; }
    if (curH > maxH) { overlay.style.height = maxH + 'px'; }
  };
  window.addEventListener('resize', clampOverlayToViewport);
  // Clean up listener when overlay is removed
  new MutationObserver((_, obs) => {
    if (!document.getElementById('nextdoor-moderator-overlay')) {
      window.removeEventListener('resize', clampOverlayToViewport);
      obs.disconnect();
    }
  }).observe(document.body, { childList: true, subtree: false });

  let contentHTML = '';

  // Validation: Handle media-only posts
  if (validation.hasMediaOnly) {
    contentHTML += `
      <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 12px 16px; color: #92400e; margin-bottom: 12px; font-size: 13px;">
        <strong>Media-Only Post:</strong> This post contains ${originalPost.mediaCount} ${originalPost.mediaTypes.toLowerCase()} but no text.
        <br><br>
        <strong>Required:</strong> You MUST describe the media content in the "Additional Context" field below before analyzing.
      </div>
    `;
  } else if (!validation.hasOriginalPost) {
    contentHTML += `
      <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 12px 16px; color: #92400e; margin-bottom: 12px; font-size: 13px;">
        <strong>Error:</strong> Could not find original post content or media
      </div>
    `;
  }

  if (!validation.postIsFlagged && !validation.hasFlaggedComments) {
    contentHTML += `
      <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 12px 16px; color: #92400e; margin-bottom: 12px; font-size: 13px;">
        <strong>Error:</strong> No flagged content found
      </div>
    `;
  }

  // Success case
  if (validation.hasOriginalPost && (validation.postIsFlagged || validation.hasFlaggedComments)) {
    const multipleWarning = validation.multipleFlags ? `
      <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 12px 16px; color: #92400e; margin-bottom: 12px; font-size: 13px;">
        <strong>Warning:</strong> Multiple items flagged. Analyzing first one only.
      </div>
    ` : '';

    contentHTML = `
      ${multipleWarning}

      <div style="margin-bottom: 16px;">
        <h4 style="font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin: 0 0 12px 0; padding: 0;">Original Post</h4>
        <div style="font-size: 13px; color: #374151; margin-bottom: 4px;">
          <strong>${originalPost.author}</strong>
        </div>
        <div style="font-size: 12px; color: #9ca3af; margin-bottom: 12px;">
          ${originalPost.createdAt} &bull; ${originalPost.neighborhood}
        </div>
        <div style="background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px 16px; line-height: 1.6; color: #1f2937; font-size: 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); white-space: pre-wrap;">${originalPost.content.trim()}${renderImageAttachments(originalPost.imageUrls, !!originalPost.content)}</div>
      </div>

      ${flaggedContent.conversationThread && flaggedContent.conversationThread.length > 0 ? formatConversationThread(flaggedContent.conversationThread) : ''}

      <div style="margin-bottom: 16px;">
        <h4 style="font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin: 0 0 12px 0; padding: 0;">Flagged Content</h4>
        ${flaggedContent.type === 'post' ? `
          <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 12px 16px; color: #991b1b; font-size: 13px; font-weight: 500; margin-bottom: 8px;">
            Original post is flagged
          </div>
        ` : `
          <div style="font-size: 13px; color: #374151; margin-bottom: 4px;">
            <strong>${flaggedContent.author}</strong>
          </div>
          <div style="font-size: 12px; color: #9ca3af; margin-bottom: 12px;">
            ${flaggedContent.createdAt}
            ${flaggedContent.depth !== undefined ? ` &bull; Depth: ${flaggedContent.depth}` : ''}
          </div>
          <div style="background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px 16px; line-height: 1.6; color: #1f2937; font-size: 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.06);">
            ${flaggedContent.content || ''}
            ${renderImageAttachments(flaggedContent.imageUrls, !!flaggedContent.content)}
            ${!flaggedContent.content && !(flaggedContent.imageUrls?.length > 0) ? '<span style="color:#9ca3af; font-style:italic; font-size:13px;">(no text content)</span>' : ''}
          </div>
        `}
        ${formatModerationDetails(flaggedContent.moderationDetails)}
      </div>
    `;
  }

  scrollWrapper.innerHTML = `
    ${contentHTML}
    <div style="margin-top: 16px; border-top: 1px solid #e5e7eb; padding-top: 16px;">
      <div style="margin-bottom: 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <label for="additional-context" style="font-size: 12px; font-weight: 600; color: #374151; letter-spacing: 0.01em;">
            Additional Context ${(validation.hasMediaOnly || validation.hasVideos) ? '<span style="color: #dc2626;">*</span>' : '(optional)'}
          </label>
          <button id="clear-context-btn" style="background: none; border: 1px solid #d1d5db; border-radius: 5px; padding: 2px 8px; font-size: 11px; font-weight: 500; color: #6b7280; cursor: pointer; display: ${savedReview?.additionalContext ? 'inline-block' : 'none'};" title="Clear saved context">Clear</button>
        </div>
        <textarea
          id="additional-context"
          placeholder="${validation.hasVideos ? 'REQUIRED: Describe the video content shown in this post...' : validation.hasMediaOnly ? 'REQUIRED: Describe the image/video/media content shown in this post...' : 'Describe images, videos, links, or other context not visible in the text (e.g., \'Post includes image of political yard sign\' or \'Video shows heated argument\')'}"
          style="
            width: 100%;
            min-height: 60px;
            max-height: 200px;
            padding: 10px 12px;
            border: 1.5px solid ${(validation.hasMediaOnly || validation.hasVideos) ? '#fca5a5' : '#e5e7eb'};
            border-radius: 8px;
            font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
            font-size: 13px;
            color: #1f2937;
            background: ${(validation.hasMediaOnly || validation.hasVideos) ? '#fffbfb' : 'white'};
            resize: vertical;
            box-sizing: border-box;
            box-shadow: 0 1px 2px rgba(0,0,0,0.04);
          "
        ></textarea>
        ${validation.hasVideos ? `
          <div style="font-size: 12px; color: #dc2626; margin-top: 4px;">
            <strong>This field is REQUIRED</strong> — this post contains video that cannot be sent to the AI. Please describe what the video shows.
          </div>
        ` : validation.hasMediaOnly ? `
          <div style="font-size: 12px; color: #dc2626; margin-top: 4px;">
            <strong>This field is REQUIRED</strong> because the post has no text content.
          </div>
        ` : `
          <div style="font-size: 11px; color: #9ca3af; margin-top: 4px;">
            This context will be included in the LLM analysis to provide additional information about media or context not visible in the text.
          </div>
        `}
      </div>
      <div style="display: flex; align-items: center; gap: 14px; margin-top: 10px; flex-wrap: wrap;">
        <button id="analyze-btn" style="
          background: #111827;
          border: none;
          border-radius: 8px;
          padding: 9px 18px;
          font-size: 13px;
          font-weight: 600;
          color: white;
          cursor: pointer;
          font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
        ">
          🤖 Analyze with AI
        </button>
        <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: #6b7280; cursor: pointer; user-select: none;">
          <input type="checkbox" id="include-thread-ctx" style="width: 14px; height: 14px; cursor: pointer; accent-color: #111827;">
          Include thread context <span style="font-weight: 400; color: #9ca3af;">(send full conversation thread to AI)</span>
        </label>
      </div>
      <div id="ai-analysis-container" style="margin-top: 16px;"></div>
      <div id="nd-qa-section" style="margin-top:16px; border-top:1px solid #e5e7eb; padding-top:14px;">
        <div id="nd-qa-history" style="display:flex; flex-direction:column; gap:10px; margin-bottom:10px;"></div>
        <div style="display:flex; gap:8px; align-items:flex-start;">
          <textarea id="nd-qa-input" rows="1" placeholder="Ask about this post… e.g. 'Why are we policing this?'" style="flex:1; padding:9px 12px; border:1.5px solid #e5e7eb; border-radius:8px; font-family:system-ui,sans-serif; font-size:13px; color:#374151; resize:none; box-sizing:border-box; line-height:1.4; overflow:hidden;"></textarea>
          <button id="nd-qa-send" style="padding:9px 14px; background:#111827; color:white; border:none; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; font-family:system-ui,sans-serif; white-space:nowrap; flex-shrink:0;">Ask</button>
        </div>
      </div>
    </div>
  `;

  // Add build info footer (load asynchronously after overlay is in DOM)
  const addBuildInfoFooter = async () => {
    try {
      const buildInfoUrl = browser.runtime.getURL('build-info.json');
      const response = await fetch(buildInfoUrl);
      const buildInfo = await response.json();

      const footer = document.createElement('div');
      footer.style.cssText = 'text-align: center; padding: 12px; color: #d1d5db; font-size: 11px; border-top: 1px solid #e5e7eb; margin-top: 16px; background: #f8fafc; border-radius: 0 0 12px 12px;';

      let footerText = `Version ${buildInfo.version}`;

      if (buildInfo.buildTime) {
        const buildDate = new Date(buildInfo.buildTime);
        const formattedDate = buildDate.toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });
        footerText += ` • Built: ${formattedDate}`;
      }

      footer.textContent = footerText;
      scrollWrapper.appendChild(footer);
    } catch (error) {
      console.error('Error loading build info:', error);
      // Fallback: show version only from manifest
      const manifest = browser.runtime.getManifest();
      const footer = document.createElement('div');
      footer.style.cssText = 'text-align: center; padding: 8px; color: #999; font-size: 11px; border-top: 1px solid #ddd; margin-top: 16px;';
      footer.textContent = `Version ${manifest.version}`;
      scrollWrapper.appendChild(footer);
    }
  };

  // Dark header bar
  const headerBar = document.createElement('div');
  headerBar.style.cssText = `
    background: #111827;
    padding: 16px 20px;
    border-radius: 12px 12px 0 0;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
  `;
  headerBar.innerHTML = `
    <span style="color: #f9fafb; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;">Moderation Review</span>
    <div style="display: flex; align-items: center; gap: 8px;">
      <button id="copy-all-btn" style="background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: #d1d5db; border-radius: 6px; padding: 5px 12px; font-size: 12px; font-weight: 500; cursor: pointer; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;" title="Copy post tree + AI decision to clipboard">Copy All</button>
      <button id="close-overlay" style="background: none; border: none; font-size: 20px; line-height: 1; cursor: pointer; color: #9ca3af; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;">&times;</button>
    </div>
  `;

  // Vote action footer — sits below scroll area, always visible
  const voteFooter = document.createElement('div');
  voteFooter.id = 'nd-vote-footer';
  voteFooter.style.cssText = `
    flex-shrink: 0;
    padding: 16px 20px;
    background: white;
    border-top: 2px solid #e5e7eb;
    border-radius: 0 0 12px 12px;
    display: none;
  `;

  // Add scrollWrapper into overlay, then add to DOM
  overlay.insertBefore(headerBar, resizeHandle);
  overlay.insertBefore(scrollWrapper, resizeHandle);
  overlay.insertBefore(voteFooter, resizeHandle);
  document.body.appendChild(backdrop);
  document.body.appendChild(overlay);

  // Restore saved additional context
  const additionalContextTextarea = overlay.querySelector('#additional-context');
  if (savedReview?.additionalContext && additionalContextTextarea) {
    additionalContextTextarea.value = savedReview.additionalContext;
  }

  // Restore saved AI analysis with cache banner
  const analysisContainer = overlay.querySelector('#ai-analysis-container');
  if (savedReview?.analysisHtml && analysisContainer) {
    analysisContainer.innerHTML = `
      <div id="cache-banner" style="background: #e3f2fd; border: 1px solid #90caf9; border-radius: 4px; padding: 8px 12px; margin-bottom: 8px; font-size: 12px; color: #1565c0; display: flex; justify-content: space-between; align-items: center;">
        <span>Previously generated analysis (restored from cache)</span>
        <button id="dismiss-cache-banner" style="background: none; border: none; cursor: pointer; color: #1565c0; font-size: 14px;">&times;</button>
      </div>
    ` + savedReview.analysisHtml;
    // Heal cache poisoned by the old bug: keep only the banner we just prepended
    analysisContainer.querySelectorAll('#cache-banner').forEach((b, i) => { if (i > 0) b.remove(); });
    // Dismiss banner handler
    analysisContainer.querySelector('#dismiss-cache-banner')?.addEventListener('click', () => {
      analysisContainer.querySelector('#cache-banner')?.remove();
    });
    // Re-attach copy button handlers
    analysisContainer.querySelectorAll('[data-copy-text]').forEach(btn => {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(btn.dataset.copyText).then(() => {
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
        });
      });
    });
    // Show Re-analyze button since cached analysis is present
    const cachedAnalyzeBtn = overlay.querySelector('#analyze-btn');
    if (cachedAnalyzeBtn) cachedAnalyzeBtn.style.display = 'inline-block';
    // Scroll cached analysis into view after overlay is added to DOM
    requestAnimationFrame(() => analysisContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));

    // Show vote footer from cached data
    const cachedContentId = flaggedContent?.id;
    if (savedReview.analysisText && cachedContentId) {
      requestAnimationFrame(() => showVoteFooter(savedReview.analysisText, cachedContentId));
    } else {
      // Fallback: parse comment from HTML data-copy-text
      const copyMatch = savedReview.analysisHtml?.match(/data-copy-text="([^"]+)"/);
      const cachedComment = copyMatch ? decodeURIComponent(copyMatch[1].replace(/&quot;/g, '"')) : '';
      const cachedVoteMatch = savedReview.analysisHtml?.match(/[✓✗−]\s*(Keep|Remove|Maybe Remove)/i);
      const cachedVote = cachedVoteMatch?.[1] || 'keep';
      if (cachedContentId) {
        const syntheticText = `**Vote Suggestion:** ${cachedVote}\n**Comment Suggestion:** ${cachedComment}`;
        requestAnimationFrame(() => showVoteFooter(syntheticText, cachedContentId));
      }
    }
  }

  // Save function — captures current state
  const saveCurrentState = async () => {
    const ctx = additionalContextTextarea?.value.trim() || '';
    const analysisEl = overlay.querySelector('#ai-analysis-container');
    let html = '';
    if (analysisEl) {
      // Strip the cache banner before persisting — otherwise it gets baked into
      // the saved HTML and a new one is prepended on every reopen (stacking up).
      const clone = analysisEl.cloneNode(true);
      clone.querySelectorAll('#cache-banner').forEach(n => n.remove());
      html = clone.innerHTML;
    }
    if (ctx || html) {
      await savePostReview(postId, { additionalContext: ctx, analysisHtml: html });
    }
  };

  // Remove function for cleanup (saves before closing)
  const removeOverlay = async () => {
    await saveCurrentState();
    backdrop.remove();
    overlay.remove();
  };

  // Close button handler
  const closeBtn = overlay.querySelector('#close-overlay');
  closeBtn?.addEventListener('click', removeOverlay);

  // Click outside to close (click on backdrop)
  backdrop.addEventListener('click', removeOverlay);

  // Clear context button
  const clearBtn = overlay.querySelector('#clear-context-btn');
  clearBtn?.addEventListener('click', async () => {
    if (additionalContextTextarea) additionalContextTextarea.value = '';
    clearBtn.style.display = 'none';
    await clearPostReview(postId);
  });

  // Copy All button handler
  const copyAllBtn = overlay.querySelector('#copy-all-btn');
  copyAllBtn?.addEventListener('click', () => {
    const reviewData = JSON.parse(overlay.dataset.reviewData || '{}');
    const { originalPost, flaggedContent } = reviewData;
    const lines = [];

    lines.push('=== ORIGINAL POST ===');
    lines.push(`Author: ${originalPost?.author || 'Unknown'}`);
    if (originalPost?.createdAt) lines.push(`Posted: ${originalPost.createdAt}`);
    lines.push(originalPost?.content || '(no text)');
    if (originalPost?.imageUrls?.length > 0) {
      originalPost.imageUrls.forEach(url => lines.push(`[Image: ${url}]`));
    }

    const thread = flaggedContent?.conversationThread;
    if (thread && thread.length > 0) {
      lines.push('');
      lines.push('=== CONVERSATION THREAD ===');
      thread.forEach(c => {
        const indent = '  '.repeat(c.depth || 0);
        lines.push(`${indent}[${c.author}]: ${c.content}`);
      });
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
    const mod = flaggedContent?.moderationDetails;
    if (mod?.tags?.length) lines.push(`Tags: ${mod.tags.map(t => `${t.reason} (${t.reporter})`).join(', ')}`);
    if (mod?.votes) {
      const v = mod.votes;
      lines.push(`Votes: Keep ${v.keep || 0} / Remove ${v.remove || 0} / Maybe Remove ${v.abstain || 0} / Report ${v.report || 0}`);
    }
    if (mod?.reviewerNotes?.length) {
      lines.push('Reporter notes:');
      mod.reviewerNotes.forEach(n => lines.push(`  - ${n}`));
    }

    const ctx = overlay.querySelector('#additional-context')?.value?.trim();
    if (ctx) {
      lines.push('');
      lines.push('=== ADDITIONAL CONTEXT ===');
      lines.push(ctx);
    }

    const analysisText = overlay.querySelector('#ai-analysis-container')?.innerText?.trim();
    if (analysisText) {
      lines.push('');
      lines.push('=== AI ANALYSIS ===');
      lines.push(analysisText);
    }

    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      copyAllBtn.textContent = 'Copied!';
      setTimeout(() => { copyAllBtn.textContent = 'Copy All'; }, 1500);
    });
  });

  // Q&A section
  const qaInput = overlay.querySelector('#nd-qa-input');
  const qaSendBtn = overlay.querySelector('#nd-qa-send');
  const qaHistory = overlay.querySelector('#nd-qa-history');

  // Auto-resize textarea as user types
  qaInput?.addEventListener('input', () => {
    qaInput.style.height = 'auto';
    qaInput.style.height = qaInput.scrollHeight + 'px';
  });

  // Submit on Enter (Shift+Enter for newline)
  qaInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      qaSendBtn?.click();
    }
  });

  const submitQuestion = async () => {
    const question = qaInput?.value?.trim();
    if (!question || qaSendBtn?.disabled) return;

    // Add user bubble
    const userBubble = document.createElement('div');
    userBubble.style.cssText = 'background:#111827; color:white; border-radius:10px 10px 2px 10px; padding:9px 13px; font-size:13px; font-family:system-ui,sans-serif; align-self:flex-end; max-width:90%; line-height:1.45;';
    userBubble.textContent = question;
    qaHistory?.appendChild(userBubble);

    qaInput.value = '';
    qaInput.style.height = 'auto';
    qaSendBtn.disabled = true;
    qaSendBtn.textContent = '…';

    // Add typing indicator
    const typingBubble = document.createElement('div');
    typingBubble.style.cssText = 'background:#f3f4f6; color:#6b7280; border-radius:10px 10px 10px 2px; padding:9px 13px; font-size:13px; font-family:system-ui,sans-serif; align-self:flex-start; max-width:90%;';
    typingBubble.textContent = '…';
    qaHistory?.appendChild(typingBubble);
    typingBubble.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    const reviewData = JSON.parse(overlay.dataset.reviewData || '{}');
    const analysisText = overlay.querySelector('#ai-analysis-container')?.innerText?.trim() || '';

    // Collect prior conversation turns from the chat UI
    const history = [];
    if (qaHistory) {
      const bubbles = Array.from(qaHistory.children);
      for (const bubble of bubbles) {
        const isUser = bubble.style.alignSelf === 'flex-end' || bubble.style.background?.includes('111827');
        const text = bubble.textContent?.trim();
        if (text) history.push({ role: isUser ? 'user' : 'assistant', content: text });
      }
    }

    try {
      const resp = await browser.runtime.sendMessage({
        action: 'askAboutPost',
        question,
        reviewData,
        analysisText,
        history,
      });

      const answer = resp?.answer || 'No response.';
      const revisedMatch = answer.match(/\*\*Revised:\s*(Keep|Maybe Remove|Remove)\s*[—\-]\s*(.+?)\*\*/i);
      const mainText = answer.replace(/\*\*Revised:.*?\*\*/i, '').trim();

      typingBubble.style.cssText = 'background:#f3f4f6; color:#1f2937; border-radius:10px 10px 10px 2px; padding:9px 13px; font-size:13px; font-family:system-ui,sans-serif; align-self:flex-start; max-width:90%; line-height:1.5; white-space:pre-wrap;';
      typingBubble.textContent = mainText;

      if (revisedMatch) {
        const vote = revisedMatch[1];
        const comment = revisedMatch[2].trim();
        const voteColors = { 'Keep': '#166534', 'Remove': '#991b1b', 'Maybe Remove': '#92400e' };
        const voteBgs = { 'Keep': '#f0fdf4', 'Remove': '#fef2f2', 'Maybe Remove': '#fffbeb' };
        const color = voteColors[vote] || '#374151';
        const bg = voteBgs[vote] || '#f9fafb';
        const pill = document.createElement('div');
        pill.style.cssText = `margin-top:8px; padding:8px 11px; background:${bg}; border-left:3px solid ${color}; border-radius:0 6px 6px 0; font-size:12px; color:${color}; font-family:system-ui,sans-serif;`;
        pill.innerHTML = `<strong>Revised: ${vote}</strong> — ${comment}`;
        typingBubble.appendChild(pill);
      }
    } catch (err) {
      typingBubble.style.color = '#c62828';
      typingBubble.textContent = 'Error: ' + err.message;
    }

    typingBubble.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    qaSendBtn.disabled = false;
    qaSendBtn.textContent = 'Ask';
    qaInput?.focus();
  };

  qaSendBtn?.addEventListener('click', submitQuestion);

  // Show clear button when context is typed
  additionalContextTextarea?.addEventListener('input', () => {
    const clearBtnEl = overlay.querySelector('#clear-context-btn');
    if (clearBtnEl) {
      clearBtnEl.style.display = additionalContextTextarea.value.trim() ? 'inline-block' : 'none';
    }
  });

  // Prevent clicks inside overlay from closing it
  overlay.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  // Analyze button handler
  const analyzeBtn = overlay.querySelector('#analyze-btn');
  analyzeBtn?.addEventListener('click', () => {
    const analysisContainer = overlay.querySelector('#ai-analysis-container');
    const additionalContextTextarea = overlay.querySelector('#additional-context');
    if (!analysisContainer) return;

    // Get additional context from textarea
    const additionalContext = additionalContextTextarea?.value.trim() || '';

    // Validate: For media-only or video posts, additional context is REQUIRED
    if ((validation.hasMediaOnly || validation.hasVideos) && !additionalContext) {
      const msg = validation.hasVideos
        ? 'Additional Context is required for posts with video. Please describe what the video shows.'
        : 'Additional Context is required for media-only posts. Please describe the content of the image/video/media.';
      analysisContainer.innerHTML = `
        <div style="background: #ffebee; border: 1px solid #f44336; border-radius: 4px; padding: 12px; color: #c62828;">
          <strong>Error:</strong> ${msg}
        </div>
      `;
      additionalContextTextarea.style.border = '2px solid #f44336';
      additionalContextTextarea.focus();
      return;
    }

    // Show loading state in the analysis container
    analyzeBtn.disabled = true;
    analyzeBtn.style.display = 'none';
    analysisContainer.innerHTML = `
      <div style="display: flex; align-items: center; gap: 10px; padding: 14px 16px; background: white; border: 1px solid #e5e7eb; border-radius: 10px; color: #6b7280; font-size: 13px;">
        <span style="display: inline-block; animation: spin 1s linear infinite; font-size: 16px;">⟳</span>
        Analyzing…
      </div>
    `;

    // Add spinner animation if not exists
    if (!document.getElementById('spinner-style')) {
      const style = document.createElement('style');
      style.id = 'spinner-style';
      style.textContent = `
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `;
      document.head.appendChild(style);
    }

    // Send to background script with additional context and image URLs
    const includeThread = overlay.querySelector('#include-thread-ctx')?.checked ?? false;
    browser.runtime.sendMessage({
      action: 'analyzeContent',
      data: {
        originalPost: data.originalPost,
        flaggedContent: data.flaggedContent,
        conversationThread: includeThread ? (data.flaggedContent?.conversationThread || []) : [],
        additionalContext: additionalContext,
        imageUrls: data.flaggedContent?.imageUrls?.length > 0
          ? data.flaggedContent.imageUrls
          : (data.originalPost?.imageUrls || []),
      },
    }).then((response) => {
      console.log('[Content] Analysis request response:', response);
      if (response && typeof response === 'object' && !response.success) {
        console.error('[Content] Analysis request failed:', response.error);
        analysisContainer.innerHTML = `
          <div style="background: #ffebee; border: 1px solid #f44336; border-radius: 4px; padding: 12px; color: #c62828;">
            ${response.error || 'Analysis failed'}
          </div>
        `;
        // Re-enable button
        analyzeBtn.disabled = false;
        analyzeBtn.style.cursor = 'pointer';
        analyzeBtn.style.opacity = '1';
        analyzeBtn.innerHTML = '↺ Re-analyze';
        analyzeBtn.style.display = 'inline-block';
      } else {
        console.log('[Content] Analysis request sent, waiting for result...');
      }
    }).catch((error) => {
      console.error('[Content] Error sending analysis request:', error);
      analysisContainer.innerHTML = `
        <div style="background: #ffebee; border: 1px solid #f44336; border-radius: 4px; padding: 12px; color: #c62828;">
          ${error.message}
        </div>
      `;
      // Re-enable button
      analyzeBtn.disabled = false;
      analyzeBtn.style.cursor = 'pointer';
      analyzeBtn.style.opacity = '1';
      analyzeBtn.innerHTML = '↺ Re-analyze';
      analyzeBtn.style.display = 'inline-block';
    });
  });

  // Add build info footer after event listeners are attached
  addBuildInfoFooter();

  // Always show Analyze button — user must confirm before analysis runs
  if (!savedReview?.analysisHtml) {
    const analyzeButton = overlay.querySelector('#analyze-btn');
    if (analyzeButton) {
      analyzeButton.innerHTML = '🤖 Analyze with AI';
      analyzeButton.style.display = 'inline-block';
    }
  }
}

/**
 * Send data to background for AI analysis
 */
function sendToAI(overlayElement, data) {
  const sendBtn = overlayElement.querySelector('#send-to-ai');
  const closeBtn = overlayElement.querySelector('#close-overlay');

  // Disable button and show loading state
  sendBtn.disabled = true;
  sendBtn.style.cursor = 'not-allowed';
  sendBtn.style.opacity = '0.6';
  sendBtn.innerHTML = `
    <span style="display: inline-block; margin-right: 8px;">Analyzing...</span>
    <span style="display: inline-block; animation: spin 1s linear infinite;">⟳</span>
  `;

  // Add spinner animation if not exists
  if (!document.getElementById('spinner-style')) {
    const style = document.createElement('style');
    style.id = 'spinner-style';
    style.textContent = `
      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);
  }

  closeBtn.style.display = 'none';

  // Send to background script with full conversation thread
  browser.runtime.sendMessage({
    action: 'analyzeContent',
    data: {
      originalPost: data.originalPost,
      flaggedContent: data.flaggedContent,
      conversationThread: data.flaggedContent?.conversationThread || [],
    },
  }).then((response) => {
    console.log('[Content] sendMessage response:', response);
    // Response might be boolean true (from async handler) or an object
    if (response && typeof response === 'object' && !response.success) {
      console.error('[Content] Analysis request failed:', response.error);
      showErrorOverlay(response.error || 'Analysis failed');
    } else {
      console.log('[Content] Analysis request successful, waiting for analysisResult message...');
      // The actual result will arrive via the analysisResult message listener
    }
  }).catch((error) => {
    console.error('[Content] Error sending to background:', error);
    showErrorOverlay(error.message);
  });
}

/**
 * Show error overlay
 */
function showErrorOverlay(errorMessage) {
  const existingBackdrop = document.getElementById('nextdoor-moderator-backdrop');
  const existingOverlay = document.getElementById('nextdoor-moderator-overlay');
  existingBackdrop?.remove();
  existingOverlay?.remove();

  // Create backdrop
  const backdrop = document.createElement('div');
  backdrop.id = 'nextdoor-moderator-backdrop';
  backdrop.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.5);
    z-index: 9999;
    backdrop-filter: blur(2px);
  `;

  const overlay = document.createElement('div');
  overlay.id = 'nextdoor-moderator-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 500px;
    background: white;
    border: 2px solid #f44336;
    border-radius: 8px;
    padding: 20px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 10000;
    font-family: Arial, sans-serif;
  `;

  overlay.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
      <h3 style="margin: 0; color: #c62828;">Error</h3>
      <button id="close-overlay" style="background: none; border: none; font-size: 24px; cursor: pointer; color: #666;">&times;</button>
    </div>
    <div style="background: #ffebee; border: 1px solid #f44336; border-radius: 4px; padding: 12px; color: #c62828;">
      ${errorMessage}
    </div>
  `;

  document.body.appendChild(backdrop);
  document.body.appendChild(overlay);

  const removeOverlay = () => {
    backdrop.remove();
    overlay.remove();
  };

  overlay.querySelector('#close-overlay').addEventListener('click', removeOverlay);
  backdrop.addEventListener('click', removeOverlay);
  overlay.addEventListener('click', (e) => e.stopPropagation());
}

/**
 * Show analysis result overlay
 */
function showAnalysisOverlay(analysisText) {
  const existingBackdrop = document.getElementById('nextdoor-moderator-backdrop');
  const existingOverlay = document.getElementById('nextdoor-moderator-overlay');
  existingBackdrop?.remove();
  existingOverlay?.remove();

  // Create backdrop
  const backdrop = document.createElement('div');
  backdrop.id = 'nextdoor-moderator-backdrop';
  backdrop.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.5);
    z-index: 9999;
    backdrop-filter: blur(2px);
  `;

  const overlay = document.createElement('div');
  overlay.id = 'nextdoor-moderator-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 500px;
    max-height: 80vh;
    overflow-y: auto;
    background: white;
    border: 2px solid #4CAF50;
    border-radius: 8px;
    padding: 20px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 10000;
    font-family: Arial, sans-serif;
  `;

  overlay.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
      <h3 style="margin: 0; color: #333;">AI Analysis</h3>
      <button id="close-overlay" style="background: none; border: none; font-size: 24px; cursor: pointer; color: #666;">&times;</button>
    </div>
    <div style="background: #f5f5f5; padding: 16px; border-radius: 4px; line-height: 1.6; color: #333; font-size: 14px;">
      ${formatAIAnalysis(analysisText)}
    </div>
  `;

  document.body.appendChild(backdrop);
  document.body.appendChild(overlay);

  const removeOverlay = () => {
    console.log('[Content] Removing AI analysis overlay');
    const b = document.getElementById('nextdoor-moderator-backdrop');
    const o = document.getElementById('nextdoor-moderator-overlay');
    if (b) b.remove();
    if (o) o.remove();
  };

  // Add event listeners after elements are in DOM
  setTimeout(() => {
    const closeButton = document.getElementById('close-overlay');
    if (closeButton) {
      console.log('[Content] Close button found, attaching listener');
      closeButton.addEventListener('click', (e) => {
        console.log('[Content] Close button clicked');
        e.stopPropagation();
        removeOverlay();
      });
    } else {
      console.error('[Content] Close button not found!');
    }

    backdrop.addEventListener('click', (e) => {
      console.log('[Content] Backdrop clicked');
      removeOverlay();
    });

    overlay.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }, 50);
}

/**
 * Apply color and emoji styling to Vote Suggestion line
 */
/**
 * Auto-vote via Nextdoor's GraphQL API directly — no UI clicking needed
 * Returns true if successful
 */
async function autoVote(voteLabel, contentId, notes = '') {
  const choiceIdMap = {
    'keep': 'keep',
    'remove': 'remove',
    'maybe remove': 'consider_remove',
  };
  const choiceId = choiceIdMap[voteLabel.toLowerCase()];
  if (!choiceId || !contentId) { console.warn('[AutoVote] Missing choiceId or contentId'); return false; }

  // Content scripts run in an isolated world with moz-extension:// origin, which Nextdoor
  // rejects with 403. Inject a <script> into the page DOM to run with the page's origin.
  return new Promise((resolve) => {
    const reqId = 'ndvote-' + Date.now();

    const handler = (e) => {
      if (e.data?.type === 'ndAutoVoteResult' && e.data?.reqId === reqId) {
        window.removeEventListener('message', handler);
        console.log('[AutoVote] Result:', e.data.success, 'status:', e.data.status);
        resolve(e.data.success);
      }
    };
    window.addEventListener('message', handler);

    // Nextdoor's page CSP (script-src 'self', no 'unsafe-inline') blocks an
    // injected inline <script>, so we hand the request to the MAIN-world
    // net-hook, which runs with the page's origin/cookies but — as an
    // extension-injected content script — is exempt from the page CSP.
    window.postMessage({ source: 'ndm-vote-req', reqId, contentId, choiceId, notes }, '*');
  });
}

/**
 * Render the vote action footer (vote selector + comment + submit)
 * analysisText: raw LLM text (to parse vote/comment suggestions)
 * contentId: prefixed ID like "post_123" or "comment_456"
 */
function showVoteFooter(analysisText, contentId) {
  const footer = document.getElementById('nd-vote-footer');
  if (!footer) return;

  const voteMatch = analysisText.match(/\*\*Vote Suggestion:\*\*\s*(Keep|Remove|Maybe Remove)/i);
  const vote = (voteMatch?.[1] || 'keep').toLowerCase();

  const commentMatch = analysisText.match(/\*\*Comment Suggestion:\*\*\s*(.+?)(?:\n|$)/is);
  const commentText = commentMatch?.[1]?.trim() || '';

  const voteConfig = {
    'keep':         { label: '✓ Keep',        dark: '#166534' },
    'maybe remove': { label: '− Maybe Remove', dark: '#374151' },
    'remove':       { label: '✗ Remove',       dark: '#991b1b' },
  };

  const pillStyle = (v, selected) => {
    const dark = voteConfig[v].dark;
    return `flex:1; padding:10px 6px; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; font-family:system-ui,sans-serif; border:2px solid ${dark}; background:${selected ? dark : 'white'}; color:${selected ? 'white' : dark};`;
  };

  footer.innerHTML = `
    <div style="display:flex; gap:8px; margin-bottom:12px;">
      ${Object.entries(voteConfig).map(([v, cfg]) =>
        `<button class="nd-vote-pill" data-vote="${v}" style="${pillStyle(v, v === vote)}">${cfg.label}</button>`
      ).join('')}
    </div>
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
      <span style="font-size:11px; font-weight:600; color:#6b7280; text-transform:uppercase; letter-spacing:0.05em; font-family:system-ui,sans-serif;">Comment</span>
      <button id="nd-variations-btn" style="background:none; border:1px solid #d1d5db; border-radius:6px; padding:3px 9px; font-size:12px; cursor:pointer; color:#374151; font-family:system-ui,sans-serif;">🎲 Variations</button>
    </div>
    <textarea id="nd-vote-comment" rows="2" style="width:100%; padding:10px 12px; border:1.5px solid #e5e7eb; border-radius:8px; font-family:system-ui,sans-serif; font-size:13px; color:#374151; resize:vertical; box-sizing:border-box; margin-bottom:8px;">${commentText}</textarea>
    <div id="nd-variations-list" style="display:none; margin-bottom:10px; border:1px solid #e5e7eb; border-radius:8px; overflow:hidden;"></div>
    <button id="nd-submit-vote" style="width:100%; padding:14px; background:#111827; color:white; border:none; border-radius:8px; font-size:15px; font-weight:600; cursor:pointer; font-family:system-ui,sans-serif; letter-spacing:-0.01em;">📋 Copy Comment</button>
    <div style="margin-top:10px; padding:9px 11px; background:#f3f4f6; border-radius:7px; font-size:11.5px; color:#4b5563; line-height:1.5; font-family:system-ui,sans-serif;">Copy the comment, then cast your <strong>${voteConfig[vote].label.replace(/^[^ ]+ /, '')}</strong> vote directly on Nextdoor and paste the comment into its note field.</div>
    <div id="nd-vote-error" style="display:none; color:#c62828; font-size:12px; margin-top:8px; text-align:center;"></div>
  `;

  footer.style.display = 'block';

  let selectedVote = vote;
  const originalVote = vote;
  const originalComment = commentText;

  const variationsBtn = footer.querySelector('#nd-variations-btn');
  const variationsList = footer.querySelector('#nd-variations-list');
  const commentTextarea = footer.querySelector('#nd-vote-comment');

  // Keep the floating chip in step with the footer's live state (vote + comment),
  // so on dismiss it shows what the moderator actually selected, not the original AI pick.
  const syncChip = () => updateRecommendationChip(selectedVote, commentTextarea?.value || '');

  if (variationsBtn) variationsBtn.disabled = !originalComment.trim();

  commentTextarea?.addEventListener('input', () => {
    if (variationsBtn) variationsBtn.disabled = !commentTextarea.value.trim();
    syncChip();
  });

  footer.querySelectorAll('.nd-vote-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedVote = btn.dataset.vote;
      footer.querySelectorAll('.nd-vote-pill').forEach(b => {
        b.style.cssText = pillStyle(b.dataset.vote, b.dataset.vote === selectedVote);
      });
      if (commentTextarea) {
        commentTextarea.value = btn.dataset.vote === originalVote ? originalComment : '';
      }
      if (variationsBtn) variationsBtn.disabled = !commentTextarea?.value?.trim();
      if (variationsList) variationsList.style.display = 'none';
      syncChip();
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
          `<button class="nd-var-item" data-idx="${i}" style="display:block; width:100%; text-align:left; padding:9px 12px; background:white; border:none; border-bottom:1px solid #f3f4f6; font-size:12px; color:#374151; cursor:pointer; font-family:system-ui,sans-serif; line-height:1.4;">${v}</button>`
        ).join('');
        variationsList.style.display = 'block';
        variationsList.querySelectorAll('.nd-var-item').forEach(btn => {
          btn.addEventListener('mouseenter', () => { btn.style.background = '#f9fafb'; });
          btn.addEventListener('mouseleave', () => { btn.style.background = 'white'; });
          btn.addEventListener('click', () => {
            if (commentTextarea) commentTextarea.value = btn.textContent;
            variationsList.style.display = 'none';
            variationsBtn.textContent = '🎲 Variations';
            syncChip();
          });
        });
      } else {
        variationsList.innerHTML = `<div style="padding:10px 12px; font-size:12px; color:#6b7280; font-family:system-ui,sans-serif;">${resp?.error || 'No variations returned'}</div>`;
        variationsList.style.display = 'block';
      }
    } catch (err) {
      variationsList.innerHTML = `<div style="padding:10px 12px; font-size:12px; color:#c62828; font-family:system-ui,sans-serif;">Error: ${err.message}</div>`;
      variationsList.style.display = 'block';
    }
    variationsBtn.textContent = '🎲 Variations';
    variationsBtn.disabled = false;
  });

  footer.querySelector('#nd-submit-vote').addEventListener('click', async () => {
    const submitBtn = footer.querySelector('#nd-submit-vote');
    const errorDiv = footer.querySelector('#nd-vote-error');
    const comment = footer.querySelector('#nd-vote-comment')?.value?.trim() || '';
    errorDiv.style.display = 'none';

    try {
      await navigator.clipboard.writeText(comment);
      showVoteToast(selectedVote);
      submitBtn.textContent = '✓ Copied — vote on Nextdoor';
      submitBtn.disabled = true;
      submitBtn.style.opacity = '0.7';
      setTimeout(() => {
        submitBtn.textContent = '📋 Copy Comment';
        submitBtn.disabled = false;
        submitBtn.style.opacity = '1';
      }, 1800);
    } catch (_) {
      errorDiv.textContent = 'Copy failed — select the comment text and copy it manually.';
      errorDiv.style.display = 'block';
    }
  });

  // Mirror the current footer state onto the floating chip (initial = recommendation)
  syncChip();
}

/**
 * Show a brief toast notification for auto-vote results
 */
function showVoteToast(voteLabel) {
  const colors = { keep: '#166534', remove: '#991b1b', 'maybe remove': '#374151' };
  const icons = { keep: '✓', remove: '✗', 'maybe remove': '−' };
  const color = colors[voteLabel.toLowerCase()] || '#374151';
  const icon = icons[voteLabel.toLowerCase()] || '−';

  const toast = document.createElement('div');
  toast.style.cssText = `
    position: fixed;
    bottom: 32px;
    right: 32px;
    background: #111827;
    color: white;
    border-radius: 10px;
    padding: 14px 20px;
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-size: 14px;
    font-weight: 500;
    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    z-index: 99999;
    display: flex;
    align-items: center;
    gap: 10px;
    animation: ndToastIn 0.2s ease;
  `;
  toast.innerHTML = `
    <span style="color:${color}; font-size:18px; font-weight:700;">${icon}</span>
    <span>Comment copied — vote <strong>${voteLabel.charAt(0).toUpperCase() + voteLabel.slice(1)}</strong> on Nextdoor</span>
  `;

  if (!document.getElementById('nd-toast-style')) {
    const s = document.createElement('style');
    s.id = 'nd-toast-style';
    s.textContent = `@keyframes ndToastIn { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }`;
    document.head.appendChild(s);
  }

  document.body.appendChild(toast);
  setTimeout(() => { toast.style.transition = 'opacity 0.3s'; toast.style.opacity = '0'; }, 2500);
  setTimeout(() => toast.remove(), 2900);
}

const REC_CHIP_COLORS = {
  keep:           { bg: '#166534', label: 'Keep',         emoji: '✓' },
  remove:         { bg: '#991b1b', label: 'Remove',       emoji: '✗' },
  'maybe remove': { bg: '#374151', label: 'Maybe Remove', emoji: '−' },
};

/** Hide and empty the floating recommendation chip. */
function clearRecommendationChip() {
  const chip = document.getElementById('nd-rec-chip');
  if (!chip) return;
  chip.style.display = 'none';
  chip.innerHTML = '';
}

/**
 * Show the last AI recommendation on the floating widget.
 * Collapsed: a colored vote pill. Click reveals the suggested comment + Copy.
 * vote: 'keep' | 'remove' | 'maybe remove'; comment: suggested note (may be empty).
 */
function updateRecommendationChip(vote, comment) {
  const chip = document.getElementById('nd-rec-chip');
  if (!chip) return;

  const cfg = REC_CHIP_COLORS[(vote || '').toLowerCase()];
  if (!cfg) { clearRecommendationChip(); return; }

  const note = (comment || '').trim();
  const hasNote = note.length > 0;

  chip.innerHTML = `
    <button id="nd-rec-vote" title="${hasNote ? 'Show suggested comment' : 'Recommended vote'}" style="
      width:100%; padding:9px 13px; border:none; border-radius:8px; cursor:${hasNote ? 'pointer' : 'default'};
      font-family:system-ui,sans-serif; font-size:13px; font-weight:700; color:white;
      background:${cfg.bg}; display:flex; align-items:center; gap:8px; box-sizing:border-box; text-align:left;">
      <span style="font-size:15px;">${cfg.emoji}</span>
      <span>${cfg.label}</span>
      ${hasNote ? '<span id="nd-rec-caret" style="margin-left:auto; font-size:11px; opacity:0.85; font-weight:600;">▾ note</span>' : ''}
    </button>
    ${hasNote ? `
    <div id="nd-rec-comment" style="display:none; background:#1f2937; border-radius:8px; padding:10px; box-sizing:border-box;">
      <div id="nd-rec-comment-text" style="font-size:13.5px; color:#f9fafb; font-weight:500; line-height:1.55; white-space:pre-wrap; margin-bottom:10px; padding:9px 11px; background:#111827; border-left:3px solid ${cfg.bg}; border-radius:6px; font-family:system-ui,sans-serif;"></div>
      <button id="nd-rec-copy" style="width:100%; padding:8px; border:none; border-radius:6px; background:#374151; color:white; font-size:12px; font-weight:600; cursor:pointer; font-family:system-ui,sans-serif;">📋 Copy comment</button>
    </div>` : ''}
  `;
  chip.style.display = 'flex';

  if (!hasNote) return;

  // Set the note via textContent (LLM output is untrusted — never inject as HTML)
  chip.querySelector('#nd-rec-comment-text').textContent = note;

  const voteBtn = chip.querySelector('#nd-rec-vote');
  const commentBox = chip.querySelector('#nd-rec-comment');
  const caret = chip.querySelector('#nd-rec-caret');
  voteBtn.addEventListener('click', () => {
    const open = commentBox.style.display === 'block';
    commentBox.style.display = open ? 'none' : 'block';
    caret.textContent = open ? '▾ note' : '▴ note';
  });

  const copyBtn = chip.querySelector('#nd-rec-copy');
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(note).then(() => {
      copyBtn.textContent = '✓ Copied';
      setTimeout(() => { copyBtn.textContent = '📋 Copy comment'; }, 1500);
    }).catch(() => {
      copyBtn.textContent = 'Copy failed';
      setTimeout(() => { copyBtn.textContent = '📋 Copy comment'; }, 1500);
    });
  });
}

function styleVoteSuggestion(analysisText) {
  if (!analysisText) return analysisText;

  // Define vote styling
  const voteStyles = {
    'keep': {
      color: '#2e7d32',
      emoji: '✓',
      label: 'Keep'
    },
    'remove': {
      color: '#c62828',
      emoji: '✗',
      label: 'Remove'
    },
    'maybe remove': {
      color: '#757575',
      emoji: '−',
      label: 'Maybe Remove'
    },
    'abstain': {
      color: '#757575',
      emoji: '−',
      label: 'Abstain'
    }
  };

  // Find and replace Vote Suggestion line
  // Regex to match: **Vote Suggestion:** Keep or Remove or Maybe Remove
  const voteRegex = /\*\*Vote Suggestion:\*\*\s*(Keep|Remove|Maybe Remove|Abstain)/i;

  const styledText = analysisText.replace(voteRegex, (match, voteType) => {
    const voteLower = voteType.toLowerCase();
    const style = voteStyles[voteLower] || voteStyles['maybe remove']; // fallback to gray

    return `<strong>Vote Suggestion:</strong> <span style="color: ${style.color}; font-weight: bold;">${style.emoji} ${style.label}</span>`;
  });

  return styledText;
}

/**
 * Listen for messages from background script
 */
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Content] ===== Received message from background =====');
  console.log('[Content] Message action:', message.action);
  console.log('[Content] Full message:', message);

  // Handle API call start
  if (message.action === 'moderationFeedLoading') {
    console.log('[Content] ModerationFeed API call detected - setting loading state');
    dataIsValid = false;
    moderationFeedData = null;  // Clear stale data
    setButtonLoading();

    // Close any existing overlay from previous post
    const existingOverlay = document.getElementById('nextdoor-moderator-overlay');
    const existingBackdrop = document.getElementById('nextdoor-moderator-backdrop');
    existingOverlay?.remove();
    existingBackdrop?.remove();

    // Clear the stale recommendation chip — this is a different post now
    clearRecommendationChip();

    sendResponse({ success: true });
    return;
  }

  if (message.action === 'moderationDataReady') {
    console.log('[Content] ✓ Received moderation data from background script');
    console.log('[Content] Data keys:', message.data ? Object.keys(message.data) : 'null');
    console.log('[Content] Full data:', message.data);
    moderationFeedData = message.data;
    dataIsValid = true;
    console.log('[Content] ✓ moderationFeedData stored successfully');
    enableButton();
    sendResponse({ success: true });
    return;
  }

  if (message.action === 'scanPage') {
    const result = extractModerationData();
    sendResponse({ success: true, data: result });
  }

  if (message.action === 'analysisResult') {
    console.log('[Content] Received analysisResult:', message);

    // Find the analysis container in the existing overlay
    const analysisContainer = document.querySelector('#ai-analysis-container');
    const analyzeBtn = document.querySelector('#analyze-btn');

    if (analysisContainer && analyzeBtn) {
      // Inject analysis into the container
      if (message.analysis?.analysisText) {
        console.log('[Content] Displaying analysis in overlay:', message.analysis.analysisText.substring(0, 100));
        // Apply vote suggestion styling before formatting
        const styledAnalysisText = styleVoteSuggestion(message.analysis.analysisText);
        const formattedAnalysis = formatAIAnalysis(styledAnalysisText);

        // Extract vote for styling
        const modelInfo = message.model ? `${message.model} · ${message.provider || 'AI'}` : null;
        const voteRaw = (message.analysis.analysisText.match(/\*\*Vote Suggestion:\*\*\s*(Keep|Remove|Maybe Remove)/i) || [])[1]?.toLowerCase();
        const voteCard = {
          keep:          { border: '#16a34a', bg: '#f0fdf4', badge: '#166534', badgeBg: '#dcfce7', emoji: '✓', label: 'Keep' },
          remove:        { border: '#dc2626', bg: '#fef2f2', badge: '#991b1b', badgeBg: '#fee2e2', emoji: '✗', label: 'Remove' },
          'maybe remove':{ border: '#d97706', bg: '#fffbeb', badge: '#92400e', badgeBg: '#fef3c7', emoji: '−', label: 'Maybe Remove' },
        }[voteRaw] || { border: '#6b7280', bg: '#f9fafb', badge: '#374151', badgeBg: '#f3f4f6', emoji: '?', label: 'Unknown' };

        analysisContainer.innerHTML = `
          <div style="border:2px solid ${voteCard.border}; border-radius:10px; overflow:hidden; margin-top:12px;">
            <div style="background:${voteCard.badgeBg}; padding:12px 16px; display:flex; align-items:center; gap:10px; border-bottom:1px solid ${voteCard.border}33;">
              <span style="font-size:22px; font-weight:800; color:${voteCard.badge};">${voteCard.emoji}</span>
              <span style="font-size:17px; font-weight:700; color:${voteCard.badge}; letter-spacing:-0.01em;">${voteCard.label}</span>
              <div style="margin-left:auto; text-align:right;">
                <div style="font-size:11px; font-weight:500; color:${voteCard.badge}99; text-transform:uppercase; letter-spacing:0.05em;">AI Recommendation</div>
                ${modelInfo ? `<div style="font-size:10px; color:${voteCard.badge}66; margin-top:2px; font-family:monospace;">${modelInfo}</div>` : ''}
              </div>
            </div>
            <div style="background:${voteCard.bg}; padding:16px; font-size:13px; color:#1f2937; line-height:1.65;">
              ${formattedAnalysis}
            </div>
          </div>
        `;
        // Remove cache banner if present (this is fresh analysis)
        analysisContainer.querySelector('#cache-banner')?.remove();
        // Scroll into view
        analysisContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        // Attach copy button handlers
        analysisContainer.querySelectorAll('[data-copy-text]').forEach(btn => {
          btn.addEventListener('click', () => {
            navigator.clipboard.writeText(btn.dataset.copyText).then(() => {
              btn.textContent = 'Copied!';
              setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
            });
          });
        });
        // Save analysis to localStorage (including raw text for footer re-render)
        const overlayEl = document.querySelector('#nextdoor-moderator-overlay');
        const pid = overlayEl?.dataset?.postId;
        if (pid) {
          const ctx = document.querySelector('#additional-context')?.value?.trim() || '';
          savePostReview(pid, {
            additionalContext: ctx,
            analysisHtml: analysisContainer.innerHTML,
            analysisText: message.analysis.analysisText,
          });
        }

        // Show vote action footer
        const overlayReviewData = JSON.parse(overlayEl?.dataset?.reviewData || '{}');
        const flaggedContent = overlayReviewData.flaggedContent;
        const contentId = flaggedContent?.id;
        showVoteFooter(message.analysis.analysisText, contentId);
      } else {
        console.error('[Content] No analysisText in message:', message);
        analysisContainer.innerHTML = `
          <div style="background: #ffebee; border: 1px solid #f44336; border-radius: 4px; padding: 12px; color: #c62828;">
            No analysis result received
          </div>
        `;
      }

      // Re-enable the analyze button
      analyzeBtn.disabled = false;
      analyzeBtn.style.cursor = 'pointer';
      analyzeBtn.style.opacity = '1';
      analyzeBtn.innerHTML = '↺ Re-analyze';
      analyzeBtn.style.display = 'inline-block';
    } else {
      console.warn('[Content] Analysis container not found, falling back to legacy behavior');
      // Fallback to old behavior if container doesn't exist (shouldn't happen)
      if (message.analysis?.analysisText) {
        // Apply vote suggestion styling before displaying
        const styledAnalysisText = styleVoteSuggestion(message.analysis.analysisText);
        showAnalysisOverlay(styledAnalysisText);
      } else {
        showErrorOverlay('No analysis result received');
      }
    }

    sendResponse({ success: true });
  }

  if (message.action === 'analysisError') {
    console.error('[Content] Received analysisError:', message.error);

    // Find the analysis container in the existing overlay
    const analysisContainer = document.querySelector('#ai-analysis-container');
    const analyzeBtn = document.querySelector('#analyze-btn');

    if (analysisContainer && analyzeBtn) {
      // Display error in the container
      analysisContainer.innerHTML = `
        <div style="background: #ffebee; border: 1px solid #f44336; border-radius: 4px; padding: 12px; color: #c62828;">
          ${message.error || 'Analysis failed'}
        </div>
      `;

      // Re-enable the analyze button
      analyzeBtn.disabled = false;
      analyzeBtn.style.cursor = 'pointer';
      analyzeBtn.style.opacity = '1';
      analyzeBtn.innerHTML = '↺ Re-analyze';
      analyzeBtn.style.display = 'inline-block';
    } else {
      // Fallback to error overlay
      showErrorOverlay(message.error || 'Analysis failed');
    }

    sendResponse({ success: true });
  }

  return true;
});

/**
 * Check if we're on a moderation page
 */
function checkIfModerationPage() {
  if (!window.location.href.includes('nextdoor.com')) return false;
  return window.location.pathname.includes('/moderation_feed');
}

function enableButton() {
  const button = document.getElementById('nextdoor-moderator-trigger');
  if (button) {
    button.disabled = false;
    button.style.opacity = '1';
    button.style.cursor = 'pointer';
    button.style.background = '#166534';
    button.textContent = '⚖ AI Review';
    button.title = 'Open AI moderation analysis for this post';
  }
}

function disableButton() {
  const button = document.getElementById('nextdoor-moderator-trigger');
  if (button) {
    button.disabled = false;
    button.style.opacity = '0.45';
    button.style.cursor = 'pointer';
    button.style.background = '#1f2937';
    button.title = 'Go to moderation feed';
  }
}

function setButtonLoading() {
  const button = document.getElementById('nextdoor-moderator-trigger');
  if (!button) return;
  button.disabled = true;
  button.style.opacity = '0.7';
  button.style.cursor = 'not-allowed';
  button.style.background = '#1f2937';
  button.textContent = '⏳ Loading…';
}

/**
 * Update button state based on current page
 */
function updateButtonState() {
  if (checkIfModerationPage()) {
    enableButton();
    // console.log('[Nextdoor Moderator] Moderation page detected - button enabled');
  } else {
    disableButton();
    // console.log('[Nextdoor Moderator] Not a moderation page - button disabled');
  }
}

function injectWidget() {
  if (document.getElementById('nd-widget')) return;
  if (!window.location.href.includes('nextdoor.com')) return;

  const widget = document.createElement('div');
  widget.id = 'nd-widget';
  widget.style.cssText = `
    position: fixed;
    top: 80px;
    right: 16px;
    z-index: 2147483647;
    background: #111827;
    border-radius: 12px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.45), 0 1px 4px rgba(0,0,0,0.15);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 156px;
    font-family: system-ui, -apple-system, sans-serif;
  `;

  const brand = document.createElement('div');
  brand.style.cssText = 'font-size: 9px; color: #4b5563; text-align: center; padding: 1px 4px 5px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700;';
  brand.textContent = 'ND Moderator';
  widget.appendChild(brand);

  const mkBtn = (id, label, title) => {
    const b = document.createElement('button');
    b.id = id;
    b.textContent = label;
    if (title) b.title = title;
    b.style.cssText = `
      width: 100%; padding: 9px 13px; border: none; border-radius: 8px;
      font-size: 13px; font-weight: 600; cursor: pointer; text-align: left;
      font-family: system-ui, sans-serif; color: white; background: #1f2937;
      transition: background 0.15s, opacity 0.15s; box-sizing: border-box;
    `;
    b.addEventListener('mouseenter', () => { if (!b.disabled) b.style.background = '#374151'; });
    b.addEventListener('mouseleave', () => { if (!b.disabled) b.style.background = b._activeBg || '#1f2937'; });
    return b;
  };

  // ── AI Review button ──
  const reviewBtn = mkBtn('nextdoor-moderator-trigger', '⚖ AI Review', 'Go to moderation feed');
  reviewBtn.style.opacity = '0.45';
  reviewBtn.addEventListener('click', () => {
    if (!dataIsValid) {
      window.location.href = 'https://nextdoor.com/moderation_feed/';
      return;
    }
    const result = extractModerationData();
    createContentOverlay(result);
  });
  widget.appendChild(reviewBtn);

  // ── Recommendation chip (filled after AI Review, cleared on next/prev post) ──
  const recChip = document.createElement('div');
  recChip.id = 'nd-rec-chip';
  recChip.style.cssText = 'display:none; flex-direction:column; gap:4px;';
  widget.appendChild(recChip);

  // ── Post Panel button ──
  const panelBtn = mkBtn('nd-export-btn', '📄 Post Panel', 'Expand all replies, then preview and chat about this post');
  panelBtn.style.display = 'none';
  panelBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    panelBtn.disabled = true;
    panelBtn.style.cursor = 'not-allowed';
    panelBtn.style.opacity = '0.6';

    await expandAllReplies(panelBtn);

    panelBtn.textContent = '📄 Loading…';
    const resp = await browser.runtime.sendMessage({ action: 'getLastExpandedPost' }).catch(() => null);
    const post = resp?.post || expandedPostData;

    panelBtn.disabled = false;
    panelBtn.style.cursor = 'pointer';
    panelBtn.style.opacity = '1';
    panelBtn.textContent = '📄 Post Panel';

    if (post) showExportPreview(post);
  });
  widget.appendChild(panelBtn);

  // ── Mod History link ──
  const historyLink = document.createElement('a');
  historyLink.href = 'https://nextdoor.com/moderation_history/';
  historyLink.textContent = 'Mod History ↗';
  historyLink.title = 'View your moderation history';
  historyLink.style.cssText = `
    display: block; text-align: center; font-size: 11px; color: #6b7280;
    text-decoration: none; padding: 4px 4px 2px; margin-top: 2px;
    border-top: 1px solid #1f2937;
  `;
  historyLink.addEventListener('mouseenter', () => { historyLink.style.color = '#9ca3af'; });
  historyLink.addEventListener('mouseleave', () => { historyLink.style.color = '#6b7280'; });
  widget.appendChild(historyLink);

  document.body.appendChild(widget);

  // AI Review: enable/disable based on URL
  updateButtonState();
  window.addEventListener('popstate', updateButtonState);
  let lastUrl = window.location.href;
  setInterval(() => {
    const cur = window.location.href;
    if (cur !== lastUrl) { lastUrl = cur; updateButtonState(); }
  }, 1000);

  // Post Panel: show/hide based on expanded overlay (500ms poll)
  let wasOpen = false;
  setInterval(() => {
    const isOpen = !!document.querySelector('button[aria-label="Close expanded post"]');
    if (isOpen === wasOpen) return;
    wasOpen = isOpen;
    panelBtn.style.display = isOpen ? 'block' : 'none';
    if (!isOpen) {
      document.getElementById('nd-export-preview')?.remove();
      panelBtn.textContent = '📄 Post Panel';
      panelBtn.style.opacity = '1';
      widget.style.display = 'flex';
    }
  }, 500);
}

function waitForBody() {
  if (document.body) {
    injectWidget();
  } else {
    const observer = new MutationObserver(() => {
      if (document.body) {
        observer.disconnect();
        injectWidget();
      }
    });
    observer.observe(document.documentElement, { childList: true });
  }
}

// ─── Export Thread ────────────────────────────────────────────────────────────

let expandedPostData = null;

function renderMarkdownToHtml(md) {
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const inline = s => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/_([^_\n]+?)_/g, '<em style="color:#6b7280;">$1</em>');

  return md.split('\n').map(line => {
    const indent = (line.match(/^( +)/)?.[1]?.length || 0);
    const pl = indent * 10;
    const t = line.trimStart();

    if (t.startsWith('### ')) return `<div style="padding-left:${pl}px;margin:10px 0 2px;font-size:13px;font-weight:700;color:#111827;">${inline(t.slice(4))}</div>`;
    if (t.startsWith('## '))  return `<div style="margin:18px 0 6px;font-size:15px;font-weight:700;color:#111827;border-bottom:1px solid #e5e7eb;padding-bottom:5px;">${inline(t.slice(3))}</div>`;
    if (t.startsWith('# '))   return `<div style="margin:0 0 14px;font-size:18px;font-weight:800;color:#111827;">${inline(t.slice(2))}</div>`;
    if (t === '---')           return `<hr style="border:none;border-top:2px solid #e5e7eb;margin:10px 0;">`;
    if (t === '')              return `<div style="height:5px;"></div>`;
    return `<div style="padding-left:${pl}px;font-size:13px;color:#374151;line-height:1.6;">${inline(t)}</div>`;
  }).join('');
}

function showExportPreview(post) {
  document.getElementById('nd-export-preview')?.remove();
  const widget = document.getElementById('nd-widget');
  if (widget) widget.style.display = 'none';

  const { markdown, totalComments, missingCount } = buildMarkdownFromPostData(post, window.location.href);

  const panel = document.createElement('div');
  panel.id = 'nd-export-preview';
  panel.style.cssText = `
    position: fixed;
    top: 0; right: 0;
    width: 420px;
    height: 100vh;
    background: #fff;
    box-shadow: -4px 0 24px rgba(0,0,0,0.18);
    z-index: 2147483646;
    display: flex;
    flex-direction: column;
    font-family: system-ui, -apple-system, sans-serif;
  `;

  const tabBtn = (id, label, active) =>
    `<button id="${id}" style="flex:1; padding:8px 0; font-size:13px; font-weight:600; cursor:pointer; border:none; border-bottom:2px solid ${active ? '#f9fafb' : 'transparent'}; background:transparent; color:${active ? '#f9fafb' : '#9ca3af'}; font-family:system-ui,sans-serif; transition:color 0.15s;">${label}</button>`;

  panel.innerHTML = `
    <div style="background:#111827; padding:12px 16px; display:flex; justify-content:space-between; align-items:center; flex-shrink:0;">
      <span style="color:#f9fafb; font-size:14px; font-weight:700; letter-spacing:-0.01em;">Post Panel</span>
      <div style="display:flex; gap:8px; align-items:center;">
        <span id="nd-export-count" style="color:#9ca3af; font-size:12px;">${totalComments} comment${totalComments !== 1 ? 's' : ''}</span>
        <button id="nd-export-close" style="background:none; border:none; color:#9ca3af; font-size:20px; cursor:pointer; line-height:1; padding:0;">&times;</button>
      </div>
    </div>
    <div style="background:#1f2937; display:flex; flex-shrink:0; border-bottom:1px solid #374151;">
      ${tabBtn('nd-tab-preview', '📄 Preview', true)}
      ${tabBtn('nd-tab-chat', '💬 Chat', false)}
    </div>
    <div id="nd-export-warning" style="background:#fef3c7; border-bottom:1px solid #fcd34d; padding:10px 16px; display:${missingCount > 0 ? 'flex' : 'none'}; gap:8px; align-items:flex-start; flex-shrink:0;">
      <span style="font-size:16px; line-height:1.3;">⚠️</span>
      <div id="nd-export-warning-msg" style="font-size:12px; color:#92400e; line-height:1.5;">
        <strong>${missingCount} repl${missingCount !== 1 ? 'ies' : 'y'} not captured</strong> — this is WYSIWYG.<br>
        Click "See more replies" in the post first, then re-export.
      </div>
    </div>
    <div id="nd-panel-preview" style="flex:1; overflow-y:auto; padding:16px; background:#f9fafb;">${renderMarkdownToHtml(markdown)}</div>
    <div id="nd-panel-chat" style="flex:1; display:none; flex-direction:column; overflow:hidden;">
      <div id="nd-chat-messages" style="flex:1; overflow-y:auto; padding:14px 16px; display:flex; flex-direction:column; gap:10px; background:#f9fafb;"></div>
      <div style="padding:10px 12px; border-top:1px solid #e5e7eb; background:white; display:flex; gap:8px; align-items:flex-end; flex-shrink:0;">
        <textarea id="nd-chat-input" rows="1" placeholder="Ask about this post…" style="flex:1; padding:9px 12px; border:1.5px solid #e5e7eb; border-radius:8px; font-family:system-ui,sans-serif; font-size:13px; color:#374151; resize:none; box-sizing:border-box; line-height:1.4; overflow:hidden; max-height:120px;"></textarea>
        <button id="nd-chat-send" style="padding:9px 14px; background:#111827; color:white; border:none; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; font-family:system-ui,sans-serif; flex-shrink:0;">Ask</button>
      </div>
    </div>
    <div id="nd-preview-footer" style="padding:12px 16px; border-top:1px solid #e5e7eb; flex-shrink:0; background:white;">
      <button id="nd-export-download" style="width:100%; padding:11px; background:#111827; color:white; border:none; border-radius:8px; font-size:14px; font-weight:600; cursor:pointer; font-family:inherit;">Download .md</button>
    </div>
  `;

  document.body.appendChild(panel);

  // Tab switching
  const tabPreview = panel.querySelector('#nd-tab-preview');
  const tabChat = panel.querySelector('#nd-tab-chat');
  const viewPreview = panel.querySelector('#nd-panel-preview');
  const viewChat = panel.querySelector('#nd-panel-chat');
  const footer = panel.querySelector('#nd-preview-footer');
  const warning = panel.querySelector('#nd-export-warning');

  const switchTab = (toChat) => {
    tabPreview.style.borderBottomColor = toChat ? 'transparent' : '#f9fafb';
    tabPreview.style.color = toChat ? '#9ca3af' : '#f9fafb';
    tabChat.style.borderBottomColor = toChat ? '#f9fafb' : 'transparent';
    tabChat.style.color = toChat ? '#f9fafb' : '#9ca3af';
    viewPreview.style.display = toChat ? 'none' : 'block';
    viewChat.style.display = toChat ? 'flex' : 'none';
    footer.style.display = toChat ? 'none' : 'block';
    if (warning.style.display !== 'none') warning.style.display = toChat ? 'none' : 'flex';
  };

  tabPreview.addEventListener('click', () => switchTab(false));
  tabChat.addEventListener('click', () => switchTab(true));

  // Chat logic
  const chatMessages = panel.querySelector('#nd-chat-messages');
  const chatInput = panel.querySelector('#nd-chat-input');
  const chatSend = panel.querySelector('#nd-chat-send');
  const chatHistory = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const addBubble = (text, isUser) => {
    const div = document.createElement('div');
    div.style.cssText = isUser
      ? 'background:#111827; color:white; border-radius:10px 10px 2px 10px; padding:9px 13px; font-size:13px; align-self:flex-end; max-width:88%; line-height:1.45; font-family:system-ui,sans-serif; white-space:pre-wrap;'
      : 'background:white; color:#1f2937; border-radius:10px 10px 10px 2px; padding:9px 13px; font-size:13px; align-self:flex-start; max-width:88%; line-height:1.5; font-family:system-ui,sans-serif; box-shadow:0 1px 3px rgba(0,0,0,0.08);';
    if (isUser) {
      div.textContent = text;
    } else {
      div.innerHTML = renderMarkdownToHtml(text);
    }
    chatMessages.appendChild(div);
    div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return div;
  };

  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  });
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend.click(); }
  });

  chatSend.addEventListener('click', async () => {
    const question = chatInput.value.trim();
    if (!question || chatSend.disabled) return;

    addBubble(question, true);
    chatHistory.push({ role: 'user', content: question });
    chatInput.value = '';
    chatInput.style.height = 'auto';
    chatSend.disabled = true;
    chatSend.textContent = '…';

    const typingBubble = addBubble('…', false);

    try {
      const resp = await browser.runtime.sendMessage({
        action: 'chatAboutPost',
        question,
        markdown,
        history: chatHistory.slice(0, -1),
      });
      const answer = resp?.answer || 'No response.';
      typingBubble.innerHTML = renderMarkdownToHtml(answer);
      chatHistory.push({ role: 'assistant', content: answer });

      // Token stats
      const inTok = resp?.inputTokens;
      const outTok = resp?.outputTokens;
      if (inTok != null || outTok != null) {
        totalInputTokens += inTok || 0;
        totalOutputTokens += outTok || 0;
        const statsEl = document.createElement('div');
        statsEl.style.cssText = 'font-size:10px; color:#9ca3af; margin-top:4px; align-self:flex-start; padding-left:2px; font-family:system-ui,sans-serif;';
        statsEl.textContent = `${(inTok||0).toLocaleString()} in · ${(outTok||0).toLocaleString()} out  |  session: ${totalInputTokens.toLocaleString()} in · ${totalOutputTokens.toLocaleString()} out`;
        chatMessages.appendChild(statsEl);
      }
    } catch (err) {
      typingBubble.textContent = 'Error: ' + err.message;
      typingBubble.style.color = '#c62828';
    }

    chatSend.disabled = false;
    chatSend.textContent = 'Ask';
    typingBubble.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  panel.querySelector('#nd-export-close').addEventListener('click', () => {
    panel.remove();
    const w = document.getElementById('nd-widget');
    if (w) w.style.display = 'flex';
  });

  panel.querySelector('#nd-export-download').addEventListener('click', function() {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nextdoor-post-${new Date().toISOString().slice(0, 10)}.md`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    const dlBtn = panel.querySelector('#nd-export-download');
    dlBtn.textContent = 'Downloaded!';
    setTimeout(() => { dlBtn.textContent = 'Download .md'; }, 2000);
  });
}

async function expandAllReplies(statusBtn) {
  const overlayOpen = () => !!document.querySelector('button[aria-label="Close expanded post"]');
  if (!overlayOpen()) return { error: 'No overlay open' };

  const getSeeMoreReplies = () =>
    Array.from(document.querySelectorAll('[role="button"], button'))
      .filter(b => /see \d+ more repl/i.test(b.textContent.trim()));

  // "See more comments" is a div[role="button"] on Nextdoor's React SPA
  const getSeeMoreComments = () =>
    Array.from(document.querySelectorAll('[role="button"], button'))
      .find(el =>
        /see more comments/i.test(el.textContent.trim()) &&
        el.textContent.trim().length < 25
      );

  const delay = ms => new Promise(r => setTimeout(r, ms));
  let totalClicked = 0;
  const maxRounds = 30;

  for (let round = 0; round < maxRounds; round++) {
    if (!overlayOpen()) break;

    // PRIORITY 1: Load all top-level comment batches first so all threads are in DOM
    // before the reply expansion pass begins
    const commentLoader = getSeeMoreComments();
    if (commentLoader) {
      if (statusBtn) statusBtn.textContent = `⏳ more comments…`;
      commentLoader.click();
      totalClicked++;
      await delay(800);
      continue;
    }

    // PRIORITY 2: All top-level comments loaded — expand reply threads
    // Note: "See X more replies" also triggers a PagedComments network fetch,
    // so we settle 500ms after the batch to let the background merge responses
    const replyBtns = getSeeMoreReplies();
    if (replyBtns.length > 0) {
      if (statusBtn) statusBtn.textContent = `⏳ ${replyBtns.length} reply thread${replyBtns.length !== 1 ? 's' : ''}…`;
      for (const btn of replyBtns) {
        if (!overlayOpen()) break;
        btn.click();
        totalClicked++;
        await delay(150);
      }
      await delay(500);
      continue;
    }

    return { done: true, totalClicked, rounds: round + 1 };
  }

  return { done: false, warning: 'Hit max rounds — may be incomplete', totalClicked };
}


browser.runtime.onMessage.addListener((message) => {
  if (message.action === 'expandedPostReady') {
    expandedPostData = message.post;
    if (document.getElementById('nd-export-preview')) {
      refreshExportPreview(expandedPostData);
    }
  }
});

function refreshExportPreview(post) {
  const panel = document.getElementById('nd-export-preview');
  if (!panel) return;
  const { markdown, totalComments, missingCount } = buildMarkdownFromPostData(post, window.location.href);
  const pre = panel.querySelector('#nd-panel-preview');
  const scrollTop = pre?.scrollTop || 0;
  if (pre) {
    pre.innerHTML = renderMarkdownToHtml(markdown);
    pre.scrollTop = scrollTop;
  }
  const countEl = panel.querySelector('#nd-export-count');
  if (countEl) countEl.textContent = `${totalComments} comment${totalComments !== 1 ? 's' : ''}`;
  const warningEl = panel.querySelector('#nd-export-warning');
  if (warningEl) {
    if (missingCount > 0) {
      warningEl.style.display = 'flex';
      const msg = warningEl.querySelector('#nd-export-warning-msg');
      if (msg) msg.innerHTML = `<strong>${missingCount} repl${missingCount !== 1 ? 'ies' : 'y'} not captured</strong> — this is WYSIWYG.<br>Click "See more replies" in the post first, then re-export.`;
    } else {
      warningEl.style.display = 'none';
    }
  }
  const dlBtn = panel.querySelector('#nd-export-download');
  if (dlBtn) dlBtn._markdown = markdown;
}

function buildMarkdownFromPostData(post, pageUrl) {
  const lines = [];
  const now = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  console.log('[Export] post keys:', Object.keys(post).join(', '));
  // shareId = "sharedPost_Sd7GRS9wTTcL" → https://nextdoor.com/p/Sd7GRS9wTTcL
  const shareToken = post.shareId?.replace(/^sharedPost_/, '');
  const postUrl = post.shareUrl || post.url
    || (shareToken ? `https://nextdoor.com/p/${shareToken}` : null)
    || pageUrl;

  lines.push('# Nextdoor Post Export');
  lines.push('');
  lines.push(`**URL:** ${postUrl}`);
  lines.push(`**Exported:** ${now}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Original Post');
  lines.push('');

  const author = post.author?.displayName || 'Unknown';
  const content = post.styledBody?.text || post.body || '';
  const createdAt = post.createdAt?.asDateTime?.relativeTime || '';
  const neighborhood = post.author?.originationNeighborhood?.shortName || '';

  lines.push(`**Author:** ${author}`);
  if (createdAt) lines.push(`**Posted:** ${createdAt}`);
  if (neighborhood) lines.push(`**Neighborhood:** ${neighborhood}`);
  lines.push('');
  if (content) { lines.push(content); lines.push(''); }

  if (post.poll) {
    lines.push(`**[Poll]** ${post.poll.question || ''}`);
    if (post.poll.description) lines.push(post.poll.description);
    if (post.poll.options?.length > 0) {
      lines.push('');
      post.poll.options.forEach(opt => {
        lines.push(`- ${opt.label}${opt.voteCount != null ? ` (${opt.voteCount} votes, ${opt.votePercentText}%)` : ''}`);
      });
    }
    lines.push('');
  }

  const mediaAttachments = post.mediaAttachments || [];
  if (mediaAttachments.length > 0) {
    lines.push('**Attachments:**');
    mediaAttachments.forEach(m => {
      if (m.type === 'PHOTO' && m.url) lines.push(`- Photo: ${m.url}`);
      else if (m.type === 'VIDEO') lines.push(`- [Video attachment]`);
      else if (m.url) lines.push(`- ${m.type}: ${m.url}`);
    });
    lines.push('');
  }

  const commentLines = [];
  let totalComments = 0;
  let missingCount = 0;

  function walkComments(edges, depth) {
    (edges || []).forEach(edge => {
      const comment = edge.node?.comment;
      if (!comment) return;
      totalComments++;

      const cAuthor = comment.author?.displayName || 'Unknown';
      const cContent = comment.styledBody?.text || comment.body || '';
      const cTime = comment.createdAt?.asDateTime?.relativeTime || '';
      const indent = '  '.repeat(depth);
      const marker = depth > 0 ? '↳ ' : '';

      commentLines.push(`${indent}### ${marker}${cAuthor}`);
      if (cTime) commentLines.push(`${indent}_${cTime}_`);
      commentLines.push('');
      if (cContent) {
        cContent.split('\n').forEach(ln => commentLines.push(`${indent}${ln}`));
      }
      commentLines.push('');

      const replyEdges = edge.node?.replies?.edgesV2 || edge.node?.replies?.edges;
      // Use pageInfo.totalCount (accurate, reflects merges) instead of stale afterCount
      const replyTotal = edge.node?.replies?.pageInfo?.totalCount;
      const replyLoaded = replyEdges?.length || 0;
      if (replyTotal != null && replyTotal > replyLoaded) {
        missingCount += replyTotal - replyLoaded;
      } else if (replyTotal == null) {
        // Fall back to afterCount only when pageInfo.totalCount isn't available
        const afterCount = edge.node?.replies?.afterCount || 0;
        if (afterCount > replyLoaded) missingCount += afterCount - replyLoaded;
      }
      walkComments(replyEdges, depth + 1);
    });
  }

  const topEdges = post.comments?.pagedComments?.edgesV2 || post.comments?.pagedComments?.edges;
  const topTotal = post.comments?.pagedComments?.pageInfo?.totalCount;
  const topLoaded = topEdges?.length || 0;
  walkComments(topEdges, 0);
  // Add any missing top-level comments
  if (topTotal != null && topTotal > topLoaded) {
    missingCount += topTotal - topLoaded;
  }

  if (commentLines.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push(`## Comments (${totalComments})`);
    lines.push('');
    lines.push(...commentLines);
  }

  return { markdown: lines.join('\n'), totalComments, missingCount };
}

// ─── End Export Thread ────────────────────────────────────────────────────────

console.log('[Nextdoor Moderator] Script execution started');
console.log('[Nextdoor Moderator] readyState:', document.readyState);

// Install interceptors immediately (document_start)
// But wait for body before injecting button
if (document.readyState === 'loading') {
  console.log('[Nextdoor Moderator] Document still loading, waiting for DOMContentLoaded');
  document.addEventListener('DOMContentLoaded', waitForBody);
} else {
  console.log('[Nextdoor Moderator] Document already loaded, calling waitForBody immediately');
  waitForBody();
}
