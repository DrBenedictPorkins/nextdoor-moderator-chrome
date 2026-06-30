/**
 * Content script for Nextdoor Moderator Extension
 * Scans the page for original posts and flagged content
 *
 * Note: this DOM-scanning script is not registered in manifest.json (the API
 * interception path in content-api.js superseded it). Kept for parity with the
 * original source. The polyfill import keeps it Chrome-correct if ever wired up.
 */
import browser from 'webextension-polyfill';

console.log('[Nextdoor Moderator] Content script loaded');

// Configuration
const SELECTORS = {
  // Post container selectors
  postContainer: '[data-testid="feed-item-card"]',

  // Original post selectors (based on actual Nextdoor DOM structure)
  originalPost: '[data-testid="post-body"]',
  originalPostContent: '[data-testid="post-body"] [data-testid="styled-text"]',

  // Author selectors
  authorSection: '[data-testid="author-test"]',
  authorName: '[data-testid="author-test"] a[href*="/?is=detail_author"]',

  // Comment selectors
  commentContainer: '[data-testid="comment-detail"]',
  commentBody: '[data-testid="comment-detail-body"]',
  commentContent: '[data-testid="comment-detail-body"] [data-testid="styled-text"]',
  commentAuthor: '[data-testid="comment-detail"] a[href*="/?is=detail_commenter"]',

  // Flagged/reported indicator
  // Use SVG icon with data-icon attribute (stable, semantic selector)
  // The report icon only appears on flagged posts/comments
  reportIndicator: 'svg[data-icon="report-fill"]',
};

/**
 * Extract post content from the page
 */
function extractPostContent(element) {
  if (!element) return null;

  const contentEl = element.querySelector(SELECTORS.originalPostContent);
  const authorEl = element.querySelector(SELECTORS.authorName);

  return {
    content: contentEl?.textContent?.trim() || '',
    author: authorEl?.textContent?.trim() || 'Unknown',
    timestamp: new Date().toISOString(),
    element: element,
  };
}

/**
 * Extract comment content from a comment element
 */
function extractCommentContent(element) {
  if (!element) return null;

  const contentEl = element.querySelector(SELECTORS.commentContent);
  const authorEl = element.querySelector(SELECTORS.commentAuthor);

  return {
    content: contentEl?.textContent?.trim() || '',
    author: authorEl?.textContent?.trim() || 'Unknown',
    timestamp: new Date().toISOString(),
    element: element,
  };
}

/**
 * Find the original post on the page
 */
function findOriginalPost() {
  const posts = document.querySelectorAll(SELECTORS.originalPost);
  // First post is typically the original
  return posts.length > 0 ? posts[0] : null;
}

/**
 * Find flagged/reported comments on the page
 * Returns an array of comment elements that have report indicators
 */
function findFlaggedComments() {
  const flaggedComments = [];
  const reportIndicators = document.querySelectorAll(SELECTORS.reportIndicator);

  reportIndicators.forEach((indicator) => {
    // Traverse up the DOM to find the comment container
    let commentContainer = indicator.closest(SELECTORS.commentContainer);
    if (commentContainer) {
      flaggedComments.push(commentContainer);
    }
  });

  return flaggedComments;
}

/**
 * Find the first flagged comment (for backward compatibility)
 */
function findFlaggedPost() {
  const flaggedComments = findFlaggedComments();
  return flaggedComments.length > 0 ? flaggedComments[0] : null;
}

/**
 * Scan the page for moderation content with validation
 */
function scanPage() {
  const originalPost = findOriginalPost();
  const originalPostData = extractPostContent(originalPost);

  // Find ALL flagged items (post or comments)
  const reportIcons = document.querySelectorAll(SELECTORS.reportIndicator);
  const flaggedItems = [];

  reportIcons.forEach((icon) => {
    // Check if this is the original post being flagged
    const postBody = icon.closest(SELECTORS.originalPost);
    if (postBody && postBody === originalPost) {
      flaggedItems.push({
        type: 'post',
        element: postBody,
        data: originalPostData
      });
    }

    // Check if this is a flagged comment
    const commentDetail = icon.closest(SELECTORS.commentContainer);
    if (commentDetail) {
      flaggedItems.push({
        type: 'comment',
        element: commentDetail,
        data: extractCommentContent(commentDetail)
      });
    }
  });

  const validation = {
    hasOriginalPost: !!originalPost && !!originalPostData?.content,
    hasFlaggedContent: flaggedItems.length > 0,
    flaggedCount: flaggedItems.length,
    multipleFlags: flaggedItems.length > 1,
  };

  const data = {
    url: window.location.href,
    originalPost: originalPostData,
    flaggedItems: flaggedItems,
    flaggedContent: flaggedItems.length > 0 ? flaggedItems[0].data : null,
    validation: validation,
    scannedAt: new Date().toISOString(),
  };

  console.log('[Nextdoor Moderator] Scan results:', data);
  return data;
}

/**
 * Create Phase 1: Content Display Overlay
 */
function createContentOverlay(scanData) {
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

  let contentHTML = '';

  // Error handling
  if (!scanData.validation.hasOriginalPost) {
    contentHTML = `
      <div style="background: #ffebee; border: 1px solid #f44336; border-radius: 4px; padding: 12px; color: #c62828; margin-bottom: 12px;">
        <strong>Error:</strong> Could not find original post
      </div>
    `;
  }

  if (!scanData.validation.hasFlaggedContent) {
    contentHTML += `
      <div style="background: #ffebee; border: 1px solid #f44336; border-radius: 4px; padding: 12px; color: #c62828; margin-bottom: 12px;">
        <strong>Error:</strong> No flagged content found on this page
      </div>
    `;
  }

  // If we have both original post and flagged content, show them
  if (scanData.validation.hasOriginalPost && scanData.validation.hasFlaggedContent) {
    // Warning for multiple flagged items
    const multipleWarning = scanData.validation.multipleFlags ? `
      <div style="background: #fff3e0; border: 1px solid #ff9800; border-radius: 4px; padding: 12px; color: #e65100; margin-bottom: 12px;">
        <strong>⚠️ Warning:</strong> Multiple items flagged. Analyzing first one only.
      </div>
    ` : '';

    const firstFlagged = scanData.flaggedItems[0];
    const flaggedIndicator = firstFlagged.type === 'post'
      ? '⚠️ Original post is flagged'
      : `Flagged Comment by ${firstFlagged.data.author}`;

    contentHTML = `
      ${multipleWarning}

      <div style="margin-bottom: 16px;">
        <h4 style="margin: 0 0 8px 0; color: #333; border-bottom: 1px solid #ddd; padding-bottom: 8px;">Original Post</h4>
        <div style="margin-bottom: 8px;">
          <strong>Author:</strong> ${scanData.originalPost.author}
        </div>
        <div style="background: #f5f5f5; padding: 12px; border-radius: 4px; line-height: 1.6; color: #333;">
          ${scanData.originalPost.content}
        </div>
      </div>

      <div style="margin-bottom: 16px;">
        <h4 style="margin: 0 0 8px 0; color: #333; border-bottom: 1px solid #ddd; padding-bottom: 8px;">Flagged Content</h4>
        ${firstFlagged.type === 'post' ? `
          <div style="background: #ffebee; padding: 12px; border-radius: 4px; color: #c62828; margin-bottom: 8px;">
            <strong>⚠️ Original post is flagged</strong>
          </div>
        ` : `
          <div style="margin-bottom: 8px;">
            <strong>Author:</strong> ${firstFlagged.data.author}
          </div>
          <div style="background: #fff3e0; padding: 12px; border-radius: 4px; line-height: 1.6; color: #333; border-left: 4px solid #ff9800;">
            ${firstFlagged.data.content}
          </div>
        `}
      </div>

      <button id="send-to-ai" style="
        width: 100%;
        padding: 12px;
        background: #4CAF50;
        color: white;
        border: none;
        border-radius: 6px;
        font-size: 14px;
        font-weight: bold;
        cursor: pointer;
      ">Send to AI</button>
    `;
  }

  overlay.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
      <h3 style="margin: 0; color: #333;">Content Review</h3>
      <button id="close-overlay" style="background: none; border: none; font-size: 24px; cursor: pointer; color: #666;">&times;</button>
    </div>
    ${contentHTML}
  `;

  document.body.appendChild(overlay);

  // Close button handler
  const closeBtn = overlay.querySelector('#close-overlay');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      overlay.remove();
    });
  }

  // Send to AI button handler
  const sendBtn = overlay.querySelector('#send-to-ai');
  if (sendBtn) {
    sendBtn.addEventListener('click', () => {
      handleSendToAI(overlay, scanData);
    });
  }

  return overlay;
}

/**
 * Handle Send to AI button click
 */
function handleSendToAI(overlay, scanData) {
  const sendBtn = overlay.querySelector('#send-to-ai');
  const closeBtn = overlay.querySelector('#close-overlay');

  // Disable button and hide close button
  sendBtn.disabled = true;
  sendBtn.style.cursor = 'not-allowed';
  sendBtn.style.opacity = '0.6';
  sendBtn.innerHTML = `
    <span style="display: inline-block; margin-right: 8px;">Analyzing...</span>
    <span style="display: inline-block; animation: spin 1s linear infinite;">⟳</span>
  `;

  // Add spinning animation
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

  // Send message to background script
  browser.runtime.sendMessage({
    action: 'analyzeContent',
    data: {
      originalPost: scanData.originalPost,
      flaggedContent: scanData.flaggedContent,
    },
  }).then((response) => {
    if (response && !response.success) {
      showAnalysisError(overlay, response.error || 'Analysis failed');
    }
  }).catch((error) => {
    console.error('[Nextdoor Moderator] Error sending to background:', error);
    showAnalysisError(overlay, error.message);
  });
}

/**
 * Create Phase 2: AI Analysis Overlay
 */
function createAnalysisOverlay(analysisText) {
  // Remove existing overlay
  const existingOverlay = document.getElementById('nextdoor-moderator-overlay');
  if (existingOverlay) {
    existingOverlay.remove();
  }

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
    <div style="background: #f5f5f5; padding: 16px; border-radius: 4px; line-height: 1.6; color: #333; font-size: 15px;">
      ${analysisText}
    </div>
  `;

  document.body.appendChild(overlay);

  // Close button handler
  overlay.querySelector('#close-overlay').addEventListener('click', () => {
    overlay.remove();
  });

  return overlay;
}

/**
 * Show analysis error in overlay
 */
function showAnalysisError(overlay, errorMessage) {
  const existingOverlay = document.getElementById('nextdoor-moderator-overlay');
  if (existingOverlay) {
    existingOverlay.remove();
  }

  const errorOverlay = document.createElement('div');
  errorOverlay.id = 'nextdoor-moderator-overlay';
  errorOverlay.style.cssText = `
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

  errorOverlay.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
      <h3 style="margin: 0; color: #c62828;">Analysis Error</h3>
      <button id="close-overlay" style="background: none; border: none; font-size: 24px; cursor: pointer; color: #666;">&times;</button>
    </div>
    <div style="background: #ffebee; border: 1px solid #f44336; border-radius: 4px; padding: 12px; color: #c62828;">
      ${errorMessage}
    </div>
  `;

  document.body.appendChild(errorOverlay);

  errorOverlay.querySelector('#close-overlay').addEventListener('click', () => {
    errorOverlay.remove();
  });
}

/**
 * Listen for messages from background script
 */
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Nextdoor Moderator] Received message:', message);

  if (message.action === 'scanPage') {
    const scanData = scanPage();
    sendResponse({ success: true, data: scanData });
  }

  if (message.action === 'analysisResult') {
    // Replace first overlay with AI analysis overlay
    if (message.analysis && message.analysis.analysisText) {
      createAnalysisOverlay(message.analysis.analysisText);
    } else {
      showAnalysisError(null, 'No analysis result received');
    }
    sendResponse({ success: true });
  }

  if (message.action === 'analysisError') {
    // Show error overlay
    showAnalysisError(null, message.error || 'Analysis failed');
    sendResponse({ success: true });
  }

  return true; // Keep channel open for async response
});

/**
 * Check if current page is a Nextdoor moderation page
 * Looks for "Reported content" text in span elements
 */
function checkIfModerationPage() {
  if (!window.location.href.includes('nextdoor.com')) return false;

  // Check if URL path is the moderation feed page
  return window.location.pathname.includes('/moderation_feed');
}

/**
 * Enable the Analyze Post button
 */
function enableAnalyzeButton() {
  const button = document.getElementById('nextdoor-moderator-trigger');
  if (button) {
    button.disabled = false;
    button.style.opacity = '1';
    button.style.cursor = 'pointer';
    button.style.background = '#4CAF50';
  }
}

/**
 * Disable the Analyze Post button
 */
function disableAnalyzeButton() {
  const button = document.getElementById('nextdoor-moderator-trigger');
  if (button) {
    button.disabled = true;
    button.style.opacity = '0.5';
    button.style.cursor = 'not-allowed';
    button.style.background = '#9E9E9E';
  }
}

/**
 * Check and update button state based on page content
 */
function checkAndUpdateButton() {
  const isModerationPage = checkIfModerationPage();

  if (isModerationPage) {
    enableAnalyzeButton();
    console.log('[Nextdoor Moderator] Moderation page detected - button enabled');
  } else {
    disableAnalyzeButton();
    console.log('[Nextdoor Moderator] Not a moderation page - button disabled');
  }
}

// Add a button to trigger analysis if on a moderation page
function addModerationButton() {
  if (!window.location.href.includes('nextdoor.com')) return;

  const button = document.createElement('button');
  button.id = 'nextdoor-moderator-trigger';
  button.textContent = 'Analyze Post';
  button.disabled = true; // Start disabled
  button.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    padding: 12px 24px;
    background: #9E9E9E;
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 14px;
    font-weight: bold;
    cursor: not-allowed;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    z-index: 9999;
    opacity: 0.5;
  `;

  button.addEventListener('click', () => {
    if (button.disabled) return; // Don't do anything if disabled

    const scanData = scanPage();
    createContentOverlay(scanData);
  });

  document.body.appendChild(button);

  // Initial check after button is added
  checkAndUpdateButton();

  // Watch for page changes (SPA navigation and dynamic content)
  const observer = new MutationObserver(() => {
    checkAndUpdateButton();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  console.log('[Nextdoor Moderator] Button added with conditional enabling');
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', addModerationButton);
} else {
  addModerationButton();
}
