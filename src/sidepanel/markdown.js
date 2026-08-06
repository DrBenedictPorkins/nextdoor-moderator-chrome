/**
 * Pure data/text transforms, moved verbatim from src/content/content-api.js —
 * neither has any document/window dependency, both just build a string from a
 * post object already fetched from background's per-tab cache.
 */

export function renderMarkdownToHtml(md) {
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

export function buildMarkdownFromPostData(post, pageUrl) {
  const lines = [];
  // Collected so callers can send the actual images to the LLM. The markdown only
  // ever renders a photo as its URL, and a URL tells the model nothing about what
  // the picture shows.
  const imageUrls = [];
  // Videos can never be sent to the LLM (no frame extraction here), so track them
  // to let callers demand a written description the same way the Review tab does.
  let videoCount = 0;
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
      if (m.type === 'PHOTO' && m.url) { lines.push(`- Photo: ${m.url}`); imageUrls.push(m.url); }
      else if (m.type === 'VIDEO') { lines.push(`- [Video attachment]`); videoCount++; }
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
      (comment.mediaAttachments || []).forEach(m => {
        if (m.type === 'PHOTO' && m.url) { commentLines.push(`${indent}- Photo: ${m.url}`); imageUrls.push(m.url); }
        else if (m.type === 'VIDEO') { commentLines.push(`${indent}- [Video attachment]`); videoCount++; }
      });
      commentLines.push('');

      const replyEdges = edge.node?.replies?.edgesV2 || edge.node?.replies?.edges;
      const replyPage = edge.node?.replies?.pageInfo;
      const replyLoaded = replyEdges?.length || 0;
      // Nextdoor's totalCount is unreliable (over-counts deleted/ghost replies —
      // e.g. reports 12 when 11 exist), so only flag missing replies when the API
      // says there is genuinely another page to fetch.
      if (replyPage?.hasNextPage) {
        const replyTotal = replyPage.totalCount;
        missingCount += (replyTotal != null && replyTotal > replyLoaded) ? (replyTotal - replyLoaded) : 1;
      }
      walkComments(replyEdges, depth + 1);
    });
  }

  const topEdges = post.comments?.pagedComments?.edgesV2 || post.comments?.pagedComments?.edges;
  const topPage = post.comments?.pagedComments?.pageInfo;
  const topLoaded = topEdges?.length || 0;
  walkComments(topEdges, 0);
  // Only flag missing top-level comments when the API says another page exists —
  // totalCount alone is unreliable (Nextdoor over-counts).
  if (topPage?.hasNextPage) {
    const topTotal = topPage.totalCount;
    missingCount += (topTotal != null && topTotal > topLoaded) ? (topTotal - topLoaded) : 1;
  }

  if (commentLines.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push(`## Comments (${totalComments})`);
    lines.push('');
    lines.push(...commentLines);
  }

  return { markdown: lines.join('\n'), totalComments, missingCount, imageUrls, videoCount };
}
