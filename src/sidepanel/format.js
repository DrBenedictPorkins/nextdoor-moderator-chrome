/**
 * Pure formatting helpers, ported from src/content/content-api.js — no DOM/window
 * dependency beyond building HTML strings. Two functions (renderImageAttachments,
 * formatConversationThread) used inline onclick="..." attributes in the original,
 * which worked there because content scripts run under the PAGE's CSP (Nextdoor's),
 * not this extension's own extension_pages CSP (script-src 'self', no
 * unsafe-inline) — which DOES block inline handlers. Both are rewired to real
 * event listeners here instead; see attachImageClickHandlers/attachThreadToggleHandlers,
 * which the caller must invoke after inserting the returned HTML into the DOM.
 */

export function parseModerationSummary(moderationSummary) {
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

  const reportSummary = moderationSummary.reportModerationEventsSummary;
  if (reportSummary?.contents) {
    reportSummary.contents.forEach((content) => {
      if (content.type === 'ModerationContentRowMainTitle' && content.title?.text) {
        details.reports.push({ type: 'title', text: content.title.text });
      } else if (content.type === 'ModerationContentRowMainDescription' && content.description?.text) {
        details.reports.push({ type: 'description', text: content.description.text });
      } else if (content.type === 'ModerationContentRowSectionTitle' && content.text?.text) {
        details.reports.push({ type: 'section', text: content.text.text });
      } else if (content.type === 'ModerationContentRow' && content.leftText?.text) {
        const leftText = content.leftText.text;
        const rightText = content.rightText?.text || '';
        details.reports.push({ type: 'row', reason: leftText, count: rightText });
      } else if (content.type === 'ModerationEventSummary') {
        const topText = content.topContent?.text?.text || '';
        const icon = content.leftContent?.icon?.icon || '';
        const bottomText = content.bottomContent?.text?.text || '';

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

  const voteSummary = moderationSummary.voteModerationEventsSummary;
  if (voteSummary?.contents) {
    let isVoteTotalsSection = false;

    voteSummary.contents.forEach((content) => {
      if (content.type === 'ModerationContentRowSectionTitle' && content.text?.text) {
        const sectionTitle = content.text.text.toLowerCase();
        if (sectionTitle.includes('vote total')) {
          isVoteTotalsSection = true;
          details.votes.push({ type: 'section', text: content.text.text });
        }
      } else if (content.type === 'ModerationContentRow' && content.leftText?.text) {
        const leftText = content.leftText.text;
        const rightText = content.rightText?.text || '';
        details.votes.push({ type: 'row', reason: leftText, count: rightText, isVoteTotals: isVoteTotalsSection });
      } else if (content.type === 'ModerationEventSummary') {
        isVoteTotalsSection = false;
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

  const notesSummary = moderationSummary.addNotesModerationEventsSummary;
  if (notesSummary?.contents) {
    notesSummary.contents.forEach((content) => {
      if (content.type === 'ModerationContentRow' && content.leftText?.text) {
        details.notes.push({ text: content.leftText.text });
      }
    });
  }

  const rowReportCount = details.reports
    .filter((r) => r.type === 'row' && r.count)
    .reduce((sum, r) => sum + (parseInt(r.count) || 0), 0);
  const individualReportCount = details.reports.filter((r) => r.type === 'individual_report').length;
  details.totalReports = Math.max(rowReportCount, individualReportCount);

  const rowVoteCount = details.votes
    .filter((v) => v.type === 'row' && v.count)
    .reduce((sum, v) => sum + (parseInt(v.count) || 0), 0);
  const individualVoteCount = details.votes.filter((v) => v.type === 'individual_vote').length;
  details.totalVotes = Math.max(rowVoteCount, individualVoteCount);

  details.totalNotes = details.notes.length;

  if (moderationSummary.leftText?.text) details.collapsedLeftText = moderationSummary.leftText.text;
  if (moderationSummary.rightText?.text) details.collapsedRightText = moderationSummary.rightText.text;

  return details;
}

export function formatAIAnalysis(text) {
  if (!text) return 'No analysis available';

  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  text = text.replace(/((?:^\|.+\|\s*\n)+)/gm, (tableBlock) => {
    const rows = tableBlock.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return tableBlock;

    const isSeparator = (row) => /^\|[\s\-:|]+\|$/.test(row.trim());
    const hasSeparator = rows.length >= 2 && isSeparator(rows[1]);

    let tableHtml = '<table style="width:100%; border-collapse:collapse; margin:12px 0; font-size:13px;">';

    rows.forEach((row, idx) => {
      if (hasSeparator && idx === 1) return;
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

  text = text.replace(/^---$/gm, '<hr style="border:none; border-top:1px solid #ddd; margin:12px 0;">');

  let html = '';
  const lines = text.split('\n');

  lines.forEach(line => {
    line = line.trim();
    if (!line) {
      html += '<br>';
      return;
    }

    if (line.startsWith('<table') || line.startsWith('<hr')) {
      html += line;
      return;
    }

    if (line.startsWith('- ') || line.startsWith('* ')) {
      html += `<div style="margin-left: 20px; margin-bottom: 4px;">&bull; ${line.substring(2)}</div>`;
    } else if (line.match(/^<strong>Comment Suggestion:<\/strong>/)) {
      const copyValue = line.replace(/<\/?strong>/g, '').replace(/^Comment Suggestion:\s*/, '').trim();
      const btnId = `copy-btn-${Math.random().toString(36).substring(2, 8)}`;
      html += `<div style="margin-top: 12px; margin-bottom: 4px; font-size: 15px; display: flex; align-items: baseline; gap: 8px;">
        <span>${line}</span>
        <button id="${btnId}" data-copy-text="${copyValue.replace(/"/g, '&quot;')}" style="background: none; border: 1px solid #d1d5db; border-radius: 5px; padding: 3px 8px; font-size: 11px; font-weight: 500; color: #6b7280; cursor: pointer; white-space: nowrap; flex-shrink: 0;" title="Copy to clipboard">Copy</button>
      </div>`;
    } else if (line.match(/^<strong>[^<]+:<\/strong>/)) {
      html += `<div style="margin-top: 12px; margin-bottom: 4px; font-size: 15px;">${line}</div>`;
    } else {
      html += `<div style="margin-bottom: 4px;">${line}</div>`;
    }
  });

  return html;
}

export function renderImageAttachments(imageUrls, hasText) {
  if (!imageUrls || imageUrls.length === 0) return '';
  const marginTop = hasText ? '10px' : '0';
  return imageUrls.slice(0, 3).map(url =>
    `<img src="${url}" class="rv-attachment-img" data-open-url="${url}" style="max-width:240px; max-height:240px; object-fit:contain; border-radius:6px; margin-top:${marginTop}; display:block; cursor:pointer;" loading="lazy">`
  ).join('');
}

/** Call after inserting HTML containing renderImageAttachments() output into the DOM. */
export function attachImageClickHandlers(container) {
  container.querySelectorAll('.rv-attachment-img[data-open-url]').forEach(img => {
    img.addEventListener('click', () => window.open(img.dataset.openUrl, '_blank'));
  });
}

// Full-size preview for a captured screenshot (data: URI, not a real URL — unlike
// renderImageAttachments/attachImageClickHandlers above, window.open on a giant
// base64 URI is a worse experience than just showing it in-panel). Shared by the
// Review tab's Additional Context and Post Panel's chat attachments.
export function showImageLightbox(src) {
  const overlay = document.createElement('div');
  overlay.className = 'rv-lightbox';
  overlay.innerHTML = `<img src="${src}" alt="Captured region">`;
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

export function formatConversationThread(conversationThread) {
  if (!conversationThread || conversationThread.length === 0) return '';

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

  return `<div class="rv-thread-block" style="margin-bottom: 16px;">
    <button class="rv-thread-toggle" style="display:flex; align-items:center; gap:6px; background:none; border:none; padding:0; cursor:pointer; font-family:inherit; width:100%; text-align:left; margin-bottom:0;">
      <span class="rv-thread-chevron" style="font-size:11px; color:#9ca3af;">▸</span>
      <h4 style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:#6b7280; margin:0;">${label}${truncatedNote}</h4>
    </button>
    <div class="rv-thread-body" style="display:none; margin-top:10px;">${itemsHtml}</div>
  </div>`;
}

/** Call after inserting HTML containing formatConversationThread() output into the DOM. */
export function attachThreadToggleHandlers(container) {
  container.querySelectorAll('.rv-thread-block').forEach(block => {
    const btn = block.querySelector('.rv-thread-toggle');
    const body = block.querySelector('.rv-thread-body');
    const chevron = block.querySelector('.rv-thread-chevron');
    btn?.addEventListener('click', () => {
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? 'block' : 'none';
      chevron.textContent = collapsed ? '▾' : '▸';
    });
  });
  attachImageClickHandlers(container);
}

export function formatModerationDetails(moderationDetails) {
  if (!moderationDetails) {
    return '<div style="background: #f5f5f5; padding: 12px; border-radius: 4px; margin-top: 12px; font-size: 12px; color: #666;">No detailed moderation data available</div>';
  }

  let html = '<div style="margin-top: 12px; border-top: 1px solid #ddd; padding-top: 12px;">';

  if (moderationDetails.totalReports > 0 || moderationDetails.reports.length > 0) {
    let keepCount = 0, maybeRemoveCount = 0, removeCount = 0;
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

    const totalVotes = keepCount + maybeRemoveCount + removeCount;
    if (totalVotes > 0) {
      html += `
        <div style="display: flex; gap: 20px; padding: 12px 0; margin-bottom: 12px; border-bottom: 1px solid #f3f4f6; flex-wrap: wrap;">
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
      if (report.type === 'title') {
        if (report.text !== 'Vote totals') {
          html += `<div style="font-weight: bold; margin-bottom: 4px;">${report.text}</div>`;
        }
      } else if (report.type === 'description') {
        html += `<div style="margin-bottom: 4px; color: #666;">${report.text}</div>`;
      } else if (report.type === 'section') {
        const sectionText = report.text || '';
        const bulletPattern = /\*\s*(\d+)/g;
        const matches = [...sectionText.matchAll(bulletPattern)];
        if (!(matches.length >= 1 && matches.length <= 3)) {
          html += `<div style="margin-top: 8px; margin-bottom: 4px; font-weight: 600; color: #d32f2f;">${report.text}</div>`;
        }
      } else if (report.type === 'row') {
        const reasonText = report.reason || '';
        const countText = report.count || '';
        const combinedText = reasonText + ' ' + countText;
        const bulletPattern = /\*\s*(\d+)/g;
        const matches = [...combinedText.matchAll(bulletPattern)];
        if (!(matches.length >= 1 && matches.length <= 3)) {
          html += `<div style="display: flex; justify-content: space-between; margin-bottom: 2px; padding: 4px; background: rgba(255,255,255,0.5); border-radius: 2px;">
            <span>${report.reason}</span>
            <span style="font-weight: bold; color: #c62828;">${report.count}</span>
          </div>`;
        }
      } else if (report.type === 'individual_report') {
        let voteIcon = '', voteColor = '', voteLabel = '', voteBg = '';
        if (report.voteType === 'keep') { voteIcon = '✓'; voteColor = '#166534'; voteBg = '#dcfce7'; voteLabel = 'Keep'; }
        else if (report.voteType === 'remove') { voteIcon = '✗'; voteColor = '#991b1b'; voteBg = '#fee2e2'; voteLabel = 'Remove'; }
        else if (report.voteType === 'abstain') { voteIcon = '−'; voteColor = '#374151'; voteBg = '#f3f4f6'; voteLabel = 'Maybe remove'; }
        else if (report.voteType === 'report') { voteIcon = '🚩'; voteColor = '#c2410c'; voteBg = '#fff7ed'; voteLabel = 'Report'; }
        else { voteIcon = '−'; voteColor = '#374151'; voteBg = '#f3f4f6'; voteLabel = 'Maybe remove'; }

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

  if (moderationDetails.totalVotes > 0 || moderationDetails.votes.length > 0) {
    html += `
      <div style="background: white; border: 1px solid #dbeafe; border-radius: 10px; padding: 12px; margin-bottom: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
        <div style="font-size: 13px; font-weight: 700; color: #1e40af; margin-bottom: 12px;">
          Community Votes (${moderationDetails.totalVotes} total)
        </div>
        <div style="font-size: 12px; color: #333;">
    `;

    const voteRows = moderationDetails.votes.filter(v => v.type === 'row');
    const individualVotes = moderationDetails.votes.filter(v => v.type === 'individual_vote');

    if (voteRows.length > 0) {
      let keepCount = 0, abstainCount = 0, removeCount = 0, hasVoteTotals = false;

      voteRows.forEach((vote) => {
        const text = vote.reason || '';
        if (vote.isVoteTotals) {
          hasVoteTotals = true;
          const count = parseInt(vote.count) || 0;
          if (text.includes('Keep') || text.includes('keep')) keepCount = count;
          else if (text.includes('Remove') || text.includes('remove')) removeCount = count;
          else if (text.includes('Abstain') || text.includes('abstain') || text.includes('Maybe')) abstainCount = count;
        }
      });

      if (!hasVoteTotals) {
        voteRows.forEach((vote) => {
          const reasonText = vote.reason || '';
          const countText = vote.count || '';
          const bulletPattern = /\*\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/;
          const bulletMatchCount = countText.match(bulletPattern);
          const bulletMatchReason = reasonText.match(bulletPattern);
          const bulletMatch = bulletMatchCount || bulletMatchReason;

          if (bulletMatch) {
            keepCount = parseInt(bulletMatch[1]) || 0;
            abstainCount = parseInt(bulletMatch[2]) || 0;
            removeCount = parseInt(bulletMatch[3]) || 0;
            hasVoteTotals = true;
          }
        });
      }

      const voteTotalsSection = moderationDetails.votes.find(v => v.type === 'section');
      if (voteTotalsSection) {
        html += `<div style="font-weight: 600; color: #1976d2; margin-bottom: 8px; font-size: 13px;">${voteTotalsSection.text}</div>`;
      }

      if (hasVoteTotals || keepCount > 0 || abstainCount > 0 || removeCount > 0) {
        html += `
          <div style="display: flex; gap: 20px; padding: 12px 0; margin-bottom: 12px; border-bottom: 1px solid #f3f4f6; flex-wrap: wrap;">
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

    individualVotes.forEach((vote) => {
      let voteIcon = '', voteColor = '', voteLabel = '', voteBgV = '';
      if (vote.voteType === 'keep') { voteIcon = '✓'; voteColor = '#166534'; voteBgV = '#dcfce7'; voteLabel = 'Keep'; }
      else if (vote.voteType === 'remove') { voteIcon = '✗'; voteColor = '#991b1b'; voteBgV = '#fee2e2'; voteLabel = 'Remove'; }
      else { voteIcon = '−'; voteColor = '#374151'; voteBgV = '#f3f4f6'; voteLabel = 'Abstain'; }

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

export function styleVoteSuggestion(analysisText) {
  if (!analysisText) return analysisText;

  const voteStyles = {
    'keep': { color: '#2e7d32', emoji: '✓', label: 'Keep' },
    'remove': { color: '#c62828', emoji: '✗', label: 'Remove' },
    'maybe remove': { color: '#757575', emoji: '−', label: 'Maybe Remove' },
    'abstain': { color: '#757575', emoji: '−', label: 'Abstain' },
  };

  const voteRegex = /\*\*Vote Suggestion:\*\*\s*(Keep|Remove|Maybe Remove|Abstain)/i;

  return analysisText.replace(voteRegex, (_match, voteType) => {
    const voteLower = voteType.toLowerCase();
    const style = voteStyles[voteLower] || voteStyles['maybe remove'];
    return `<strong>Vote Suggestion:</strong> <span style="color: ${style.color}; font-weight: bold;">${style.emoji} ${style.label}</span>`;
  });
}
