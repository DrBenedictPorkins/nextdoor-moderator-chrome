function renderMarkdown(md) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = s => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  const lines = md.split('\n');
  const out = [];
  let inList = false;
  let listTag = '';

  const closeList = () => {
    if (inList) { out.push(`</${listTag}>`); inList = false; listTag = ''; }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    if (!t) { closeList(); out.push('<p style="height:6px"></p>'); continue; }
    if (t.startsWith('### ')) { closeList(); out.push(`<h3>${inline(t.slice(4))}</h3>`); continue; }
    if (t.startsWith('## '))  { closeList(); out.push(`<h2>${inline(t.slice(3))}</h2>`); continue; }
    if (t.startsWith('# '))   { closeList(); out.push(`<h1>${inline(t.slice(2))}</h1>`); continue; }
    if (t === '---')           { closeList(); out.push('<hr>'); continue; }
    if (t.startsWith('> '))   { closeList(); out.push(`<blockquote>${inline(t.slice(2))}</blockquote>`); continue; }

    const olMatch = t.match(/^\d+\.\s+(.+)/);
    const ulMatch = t.match(/^[-*]\s+(.+)/);

    if (ulMatch) {
      if (!inList || listTag !== 'ul') { closeList(); out.push('<ul>'); inList = true; listTag = 'ul'; }
      out.push(`<li>${inline(ulMatch[1])}</li>`);
      continue;
    }
    if (olMatch) {
      if (!inList || listTag !== 'ol') { closeList(); out.push('<ol>'); inList = true; listTag = 'ol'; }
      out.push(`<li>${inline(olMatch[1])}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${inline(t)}</p>`);
  }
  closeList();
  return out.join('\n');
}

chrome.runtime.sendMessage({ action: 'getGuidelines' }).then(resp => {
  const content = document.getElementById('content');
  if (!resp?.guidelines) {
    content.innerHTML = '<div id="error">Could not load guidelines.</div>';
    return;
  }
  const div = document.createElement('div');
  div.className = 'md';
  div.innerHTML = renderMarkdown(resp.guidelines);
  content.innerHTML = '';
  content.appendChild(div);
}).catch(err => {
  document.getElementById('content').innerHTML = `<div id="error">Error: ${err.message}</div>`;
});
