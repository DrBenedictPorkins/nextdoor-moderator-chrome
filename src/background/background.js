/**
 * Background service worker for Nextdoor Moderator Extension (Chrome MV3)
 * Handles API communication with the LLM service and caches GraphQL data
 * captured by the page-context net-hook (src/inject/net-hook.js).
 *
 * Note: a service worker has no DOM and is non-persistent. The Maps below
 * (capturedApiData / postDataCache / lastExpandedPostId) are keyed by tabId and
 * are rebuilt from live GraphQL traffic; they are intentionally not persisted.
 */
import browser from 'webextension-polyfill';

console.log('[Nextdoor Moderator] Background service worker initialized');

// Enable/disable LLM conversation logging

// Configuration - users should set this via the popup UI
const CONFIG = {
  apiKey: '',
  apiEndpoint: '', // e.g., OpenAI, Anthropic, etc.
  model: 'gpt-4', // Default model
};

// Nextdoor Community Guidelines (simplified - expand as needed)
const NEXTDOOR_GUIDELINES = `
## Nextdoor Community Guidelines
Source: https://help.nextdoor.com/s/article/community-guidelines?language=en_US

---

## GUIDELINE 1: BE RESPECTFUL TO YOUR NEIGHBORS
Source: https://help.nextdoor.com/s/article/Be-respectful-to-your-neighbors?language=en_US

On Nextdoor, your neighbors are real people—living right down the street or around the block. The way we speak with each other shapes our communities. When conversations stay civil and constructive, everyone benefits.

### Civil conversations

Nextdoor is a place for open conversations about what matters in your neighborhood. It’s okay to disagree, but always keep it respectful and focus on ideas—not personal attacks. This is how we build stronger communities together.

NOT ALLOWED:
- Attacking, berating, bullying, belittling, insulting, harassing, threatening, trolling, or swearing at others or their views even if you strongly disagree. This includes communication within a group or direct message and any communication (including email) directed toward Nextdoor employees, vendors, or agents.
- Posting complaints about moderation (such as reported, hidden, or removed content) in the main feed
- Continuing to contact a neighbor after they’ve asked you to stop

ALLOWED:
- Stating your opinion or disagreeing in a civil and respectful manner
- Using direct messages or meeting in person to resolve personal disputes amicably

### Public shaming

Public shaming has no place on Nextdoor. Whether it’s directly or indirectly targeting a neighbor, a public figure, or the victim of a crime, shaming others is harmful and uncivil.

IMPORTANT:
- If you’re concerned about illegal activity, contact your local law enforcement or other appropriate agency.
- Before posting, consider how your words might affect those you’re posting about, who may also be neighbors on Nextdoor.
- We may remove a post if contacted by an involved party. This includes parents/guardians of minors.

ALLOWED:
- Posting about a safety concern in your neighborhood when you do not know the person involved or how to contact them, provided that you are civil and respectful
- Posting a negative review of a service provider as long as it’s civil and describes your own personal experience

NOT ALLOWED:
- Writing disparagingly about the victim of a crime or suggesting they are to blame
- Posting a negative review of a service provider that includes personal attacks, public shaming, libel or name calling
- Geo-tagging someone’s home location without their knowledge or permission for the purposes of humiliation, shaming, or complaining

---

## GUIDELINE 2: DO NOT DISCRIMINATE
Source: https://help.nextdoor.com/s/article/Do-not-discriminate?language=en_US

Nextdoor is for all neighbors, and every neighbor should feel that they are welcome. Racism, hateful language, and discrimination of any kind have no place in our neighborhoods—online or off.

### Zero tolerance for discrimination and hate

Prohibited behaviors — Racism, discrimination, or insults:
- Discriminating against, threatening, or insulting others (including public figures) based on their membership in a protected or marginalized group. Protected and marginalized groups include: People grouped together based on their actual or perceived race, color, ethnicity, age, immigration status, national origin, religion or faith, sex or gender identity, sexual orientation, housing or socio-economic status, disability or medical condition, weight or size, and veteran status.
- Assuming that someone is engaged in suspicious activity or criminal behavior because of their race or ethnicity
- Using negative stereotypes, caricatures, or generalizations about a group—including offensive imagery or memes
- Using slurs, profanity, derogatory racial terms, or other language that reduces an individual’s humanity. This includes the use of the dehumanizing terms, “illegals,” “illegal aliens,” or “aliens” to refer to non-citizens, the use of racial code words (e.g., “Thug” or “Oriental”), as well as the use of derogatory language to refer to people who have a criminal history (e.g., “scum” or “animals”).
- Denying an individual’s gender identity or sexual orientation, or promoting support for conversion therapy and related programs.
- Mocking or attacking the beliefs, sacred symbols, movements, or institutions of marginalized or protected groups

Prohibited behaviors — Hate speech, violence, or threats:
- Showing or eliciting support for hate groups or people promoting hate
- Promoting hate-based conspiracy theories or misinformation (e.g., Holocaust denial or “Antifa is invading the suburbs”)
- Suggesting, showing, threatening, or glorifying violence—even as a joke—against anyone
- Attempting to condone or trivialize violence against others—even inadvertently (e.g., “Yeah, but that person is a criminal”)

### Support for equality

- “All Lives Matter” is prohibited when used to dismiss or diminish movements for racial equality.
- “Blue Lives Matter” is allowed when honoring, celebrating, or thanking police for their work in the community—but prohibited when used to diminish racial equality or the Black Lives Matter movement.
- “White Lives Matter” is prohibited, as this phrase is most commonly associated with white supremacist groups.
- Homophobia, biphobia, transphobia, or any mistreatment based on identity are strictly prohibited.
- Discussions in support of racial equality—such as Black Lives Matter, Stop Asian Hate, and other civil rights movements—are welcome on Nextdoor as long as they follow the Community Guidelines.
- It’s okay to disagree on policy or tactics, but posts or comments meant to undermine core messages of equality are not allowed.

---

## GUIDELINE 3: DISCUSS IMPORTANT TOPICS IN THE RIGHT PLACE
Source: https://help.nextdoor.com/s/article/Be-helpful-in-conversations?language=en_US

Nextdoor is where neighbors connect over what matters most to their local community. For important topics like non-local politics and religion, we offer Groups designed for thoughtful discussion.

### Politics

ALLOWED IN MAIN FEED AND GROUPS:
- Sharing local events, or peaceful rallies and protests that you support or plan to attend
- Sharing how a societal issue affects or has personally impacted you or your community
- Stating why you support a local cause or a local, state, or district candidate. Note: Local candidates may introduce themselves in the main feed, but may not campaign or share ongoing campaign updates there.
- Sharing ways neighbors can get involved in local causes or civic action, like voting or volunteering

NOT ALLOWED IN MAIN FEED (allowed only in Groups):
- Sharing or reposting campaign updates, including, but not limited to: endorsement announcements, fundraising or merchandise updates, or requests for donations or assistance

NOT ALLOWED IN MAIN FEED OR GROUPS:
- Sharing non-local content about national politics, federal policy, or international issues

### Religion

Religious discussions should take place in neighbor-created Groups.

### Fundraising

ALLOWED IN MAIN FEED AND GROUPS:
- School fundraisers, including links to school or teacher wishlists
- Community youth organizations
- Local pet rescue, arts organizations, fundraising events, food banks, and charity walks/runs
- Local disaster relief or emergency assistance for neighbors, including food assistance
- Kids’ bake sales, lemonade stands, and similar youth efforts

NOT ALLOWED IN MAIN FEED OR GROUPS:
- Requesting monetary donations for personal expenses or business needs, including the needs of household members and pets
- Requesting donations for non-local causes
- Requesting donations for political candidates

---

## GUIDELINE 4: USE YOUR TRUE IDENTITY
Source: https://help.nextdoor.com/s/article/use-your-true-identity

Every neighbor on Nextdoor is required to use their true identity, including their real name and address.

NOT ALLOWED:
- Using the name of your business or organization as your personal account name.
- Including professional titles or educational degrees in your name.
- Adding emoji(s) to your name.

ALLOWED:
- Using a nickname, initials, or shortened version of your first name if that’s how you’re known in the community.

---

## GUIDELINE 5: DO NOT ENGAGE IN HARMFUL ACTIVITY
Source: https://help.nextdoor.com/s/article/Do-not-engage-in-harmful-activity?language=en_US

Nextdoor prohibits activity that could harm others—whether it’s physical harm, scams, or anything putting neighbors at risk.

### Appropriately report suspicious activity

ALLOWED:
- Posting about local crime or safety concerns, including specific details like unique features and full clothing descriptions.

NOT ALLOWED:
- Posts that assume someone is suspicious because of their race or ethnicity.
- Posts that give descriptions of individuals that are so vague as to cast suspicion over an entire race or ethnicity.
- Identifying a suspect by race and sex alone (including in the subject line of a post).

### No threats to the safety of others

NOT ALLOWED:
- Threatening someone, their family or their pet’s safety
- Posting comments that encourage violence against others
- Threatening someone’s privacy or security

### No fraud, spam or prohibited goods and services

NOT ALLOWED:
- Posting fraudulent content that purposefully deceives or misrepresents in order to result in financial or personal gain. This includes but is not limited to incentivized posts or reviews of businesses.
- Posting spam, like unwanted, unsolicited, and/or repeated actions that negatively affect neighbors and the Nextdoor community. This may include but is not limited to:
  - Sending large amounts of direct messages to users who are not expecting them
  - Contacting people with unwanted content or requests
  - Repeatedly posting the same or similar content
  - Posting unoriginal/templated content with no personalization or original commentary
  - Posts that are grammatically incorrect, use all caps, rely on a variety of hashtags, @mentions, emojis, or contain only a link without context.
  - Posting more than one promotional post per week from a personal account
- Phishing, including any attempt to gain access to someone’s account or personal information
- Selling, soliciting, or offering any illegal goods or services

### No graphic, violent, sexually explicit, or adult content

NOT ALLOWED:
- Posting photos that contain nudity
- Posting sexually explicit or suggestive content
- Sending unwanted chat messages with romantic or flirtatious intent
- Posting content that is unnecessarily gruesome, gory, graphic, or violent

### No violations of privacy

ALLOWED:
- Sharing contact information when recommending a service.
- Sharing content outside of Nextdoor by using the share button that appears on posts.

NOT ALLOWED:
- Reposting information originally posted on Nextdoor beyond the author’s post visibility designation.
- Posting the content of direct messages sent through Nextdoor without the permission of the sender.
- Posting non-public legal documents.
- Posting personal contact or account information, such as email addresses, credit cards, or bank information.
- Posting a person’s legal or medical history, unless there is a compelling public interest served by doing so.
- Posting photos of people in public places. However, if a parent or guardian requests that a photo of a minor be removed from Nextdoor, we may remove it.

### Misinformation

Nextdoor is committed to neighbor safety and reducing the spread of misinformation on critical topics like elections and health emergencies. Misinformation reports go to Nextdoor staff, not community moderators, for review.

---

## FOR SALE & FREE
Items for sale or free MUST be posted using the “Sell or give away” option in the For Sale & Free section. Posting for-sale/free items in the main feed is a violation and should be removed.

NOT ALLOWED:
- Posting items for sale/free outside the For Sale & Free section (must use “Sell or give away” option)
- Listing items sold for a business, including resellers, commercial consignment, and estate sellers
- Incentive sales programs (e.g. Mary Kay, Amway, Avon, Scentsy)
- Realtors listing properties for sale, rent, or lease
- Listing gift cards
- Personal ads / dating
- Listing the same item or service more than once at the same time
- Deleting and reposting a listing to increase visibility (allowed once previous listing has expired)
- Posting links to items on other classified sites
- Price gouging during emergencies

ALLOWED:
- Selling/giving away personal items (in For Sale & Free section)
- Garage sale announcements may be posted in the main feed
- Pet adoption or re-homing (selling live animals is NOT allowed)
- Individual owners listing their own property for rent/sale

---

## NON-VIOLATION REPORT REASONS
The following report reasons are NOT guideline violations — content should NOT be removed for these alone:
- “Irrelevant or annoying” — reporter should hide/mute instead
- “Goes against my beliefs, values or politics” — not a guideline violation

---

_End of Guidelines_
`;

/**
 * Load configuration from storage
 */
async function loadConfig() {
  const stored = await browser.storage.local.get(['apiKey', 'apiEndpoint', 'model']);
  if (stored.apiKey) CONFIG.apiKey = stored.apiKey;
  if (stored.apiEndpoint) CONFIG.apiEndpoint = stored.apiEndpoint;
  if (stored.model) CONFIG.model = stored.model;
}

/**
 * Save configuration to storage
 */
async function saveConfig(config) {
  await browser.storage.local.set(config);
  Object.assign(CONFIG, config);
}



/**
 * Call LLM API to analyze content
 */
async function callLLMRaw(systemPrompt, userPrompt, maxTokens = 512) {
  const isAnthropic = CONFIG.apiEndpoint.includes('anthropic.com');
  const headers = { 'Content-Type': 'application/json' };
  let body;
  if (isAnthropic) {
    headers['x-api-key'] = CONFIG.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    body = JSON.stringify({ model: CONFIG.model, max_tokens: maxTokens, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] });
  } else {
    headers['Authorization'] = `Bearer ${CONFIG.apiKey}`;
    body = JSON.stringify({ model: CONFIG.model, max_tokens: maxTokens, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], temperature: 0.7 });
  }
  const resp = await fetch(CONFIG.apiEndpoint, { method: 'POST', headers, body });
  if (!resp.ok) throw new Error(`LLM error: ${resp.status}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || data.content?.[0]?.text || '';
}

async function callLLMQuestion(question, reviewData, analysisText, history = []) {
  const { originalPost, flaggedContent } = reviewData || {};
  const postContent = originalPost?.content || '(no text)';
  const flaggedContent_ = flaggedContent?.content || (flaggedContent?.type === 'post' ? postContent : '');

  const systemPrompt = `You are a sharp, knowledgeable assistant helping a Nextdoor moderator think about a specific post. Answer the moderator's ACTUAL question — whatever it is about.

CRITICAL RULES:
- Answer the question that was asked. It may be about the content itself, its tone, who wrote it, the context, the people involved, or anything else — not necessarily about removal. Do NOT reframe every question as a keep/remove guideline verdict.
- Only discuss guideline violations or removal when the moderator is actually asking about that, or when it is genuinely the point of their question. Guidelines are reference material below, not the lens for every answer.
- No praise, no filler, no "thank you for sharing". Be direct and concise.
- Genuinely update your position when the moderator presents a valid argument. Do NOT restate the same hedged conclusion with different words.
- It is fine to give an opinion, an observation, or a "I can't tell for certain, but here's what I notice" answer when that is what the question calls for.

OUTPUT FORMAT:
- Answer directly in 2-4 sentences max.
- ONLY if the moderator is discussing the moderation decision AND your recommendation changes from the initial analysis, end your response with a new line in EXACTLY this format:
  **Revised: [Keep/Maybe Remove/Remove] — [one sentence, specific to this content, naming the concern and why it does or doesn't rise to a violation]**
- Otherwise (general questions, or no change) do NOT include a Revised line.

Nextdoor community guidelines, for reference when relevant:
${NEXTDOOR_GUIDELINES}`;

  const context = `Post content: "${postContent}"${flaggedContent_ && flaggedContent_ !== postContent ? `\nFlagged content: "${flaggedContent_}"` : ''}${analysisText ? `\n\nInitial AI analysis:\n${analysisText.substring(0, 600)}` : ''}`;

  const isAnthropic = CONFIG.apiEndpoint.includes('anthropic.com');
  const headers = { 'Content-Type': 'application/json' };
  if (isAnthropic) {
    headers['x-api-key'] = CONFIG.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  } else {
    headers['Authorization'] = `Bearer ${CONFIG.apiKey}`;
  }

  // Build message array with history
  const messages = [
    { role: 'user', content: context },
    { role: 'assistant', content: 'Understood. I have reviewed the post and the initial analysis. Ask me anything.' },
    ...history,
    { role: 'user', content: question },
  ];

  const body = isAnthropic
    ? JSON.stringify({ model: CONFIG.model, max_tokens: 600, system: systemPrompt, messages })
    : JSON.stringify({ model: CONFIG.model, max_tokens: 600, temperature: 0.4, messages: [{ role: 'system', content: systemPrompt }, ...messages] });

  const resp = await fetch(CONFIG.apiEndpoint, { method: 'POST', headers, body });
  if (!resp.ok) throw new Error(`LLM error: ${resp.status}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || data.content?.[0]?.text || '';
}

async function callLLMChat(question, markdown, history = []) {
  const systemPrompt = `You are a sharp, knowledgeable assistant helping a Nextdoor moderator work through a specific post and its comment thread. Answer the moderator's ACTUAL question directly and usefully — summarizing, comparing, drafting, analyzing, or making best-effort inferences from the thread.

RULES:
- Be direct and concise. No praise, no filler, no preamble.
- Answer the question that was asked. Do NOT redirect to the guidelines unless the question is actually about moderation.
- For analytical or speculative asks (inferring tone, intent, demographics, etc. from what people wrote), give your best-effort read and note it's an inference — don't refuse just because it isn't certain.
- Genuinely update your position when presented with a valid argument. Do NOT restate the same conclusion with different words.
- Only when the question IS about whether to keep or remove content: cite the specific guideline that applies (or doesn't); "Keep" is the default when in doubt; if it clearly does not violate, say so plainly.

The Nextdoor community guidelines, for when a moderation question comes up:

${NEXTDOOR_GUIDELINES}`;

  const isAnthropic = CONFIG.apiEndpoint.includes('anthropic.com');
  const headers = { 'Content-Type': 'application/json' };
  if (isAnthropic) {
    headers['x-api-key'] = CONFIG.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  } else {
    headers['Authorization'] = `Bearer ${CONFIG.apiKey}`;
  }

  const messages = [
    { role: 'user', content: `Here is the full post and all its comments:\n\n${markdown}` },
    { role: 'assistant', content: 'Got it — I have read the full post and all comments. Ask me anything.' },
    ...history,
    { role: 'user', content: question },
  ];

  const body = isAnthropic
    ? JSON.stringify({ model: CONFIG.model, max_tokens: 800, system: systemPrompt, messages })
    : JSON.stringify({ model: CONFIG.model, max_tokens: 800, temperature: 0.4, messages: [{ role: 'system', content: systemPrompt }, ...messages] });

  const resp = await fetch(CONFIG.apiEndpoint, { method: 'POST', headers, body });
  if (!resp.ok) throw new Error(`LLM error: ${resp.status}`);
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || data.content?.[0]?.text || '';
  const usage = data.usage || {};
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? null;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? null;
  return { text, inputTokens, outputTokens };
}

async function callLLMForVariations(currentComment, vote) {
  const sys = `You are helping a Nextdoor community moderator write a short comment for their ${vote || 'keep'} vote. You output ONLY raw JSON, no markdown, no explanation.`;
  const user = `Current comment: "${currentComment}"\n\nGenerate exactly 8 variations of this comment. Keep a similar tone and intent but vary the phrasing. Each under 20 words. Output ONLY a valid JSON array of 8 strings. Example: ["comment 1", "comment 2", "comment 3", "comment 4", "comment 5", "comment 6", "comment 7", "comment 8"]`;
  const raw = await callLLMRaw(sys, user, 600);
  // Strip markdown code fences if present, then extract JSON array
  const cleaned = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const result = JSON.parse(match[0]);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

async function callLLMSharpResponses(content, imageUrls = []) {
  const isAnthropic = CONFIG.apiEndpoint.includes('anthropic.com');
  const sys = `You are a sharp, unapologetic commenter who calls out bad takes, hidden bias, racism, sexism, classism, and lazy thinking — directly and sarcastically. You don't sugarcoat. Output ONLY a raw JSON array of strings, no markdown, no explanation.

CRITICAL: Every comment you generate MUST comply with the Nextdoor community guidelines below. Do not generate comments that are uncivil, discriminatory, constitute public shaming, or otherwise violate these guidelines — even if the user's raw reaction is heated.

${NEXTDOOR_GUIDELINES}`;
  const textPrompt = `${content.body ? `Post/context: "${content.body}"\n` : ''}${imageUrls.length > 0 ? '(see image above)\n' : ''}${content.reaction ? `\nThe user's raw reaction: "${content.reaction}"\n\nRephrase their reaction into 6 articulate, sharp comment options that capture their intent but are suited for a public comment. Keep the edge, lose the profanity. Range from pointed to sardonic. Each under 30 words.` : `\nGenerate 6 sharp, pointed responses to this post. Call out any bias, bad logic, or hypocrisy. Range from dry eyeroll to savage takedown. Each under 25 words.`}

Output ONLY a valid JSON array of 6 strings.`;

  const headers = { 'Content-Type': 'application/json' };
  let body;

  if (isAnthropic) {
    headers['x-api-key'] = CONFIG.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    const userContent = imageUrls.length > 0
      ? [
          ...imageUrls.map(url => {
            if (url.startsWith('data:')) {
              const [meta, data] = url.split(',');
              const mediaType = meta.split(':')[1].split(';')[0];
              return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
            }
            return { type: 'image', source: { type: 'url', url } };
          }),
          { type: 'text', text: textPrompt },
        ]
      : textPrompt;
    body = JSON.stringify({ model: CONFIG.model, max_tokens: 500, system: sys, messages: [{ role: 'user', content: userContent }] });
  } else {
    headers['Authorization'] = `Bearer ${CONFIG.apiKey}`;
    const userContent = imageUrls.length > 0
      ? [
          ...imageUrls.map(url => ({ type: 'image_url', image_url: { url } })),
          { type: 'text', text: textPrompt },
        ]
      : textPrompt;
    body = JSON.stringify({ model: CONFIG.model, max_tokens: 500, messages: [{ role: 'system', content: sys }, { role: 'user', content: userContent }], temperature: 0.8 });
  }

  const resp = await fetch(CONFIG.apiEndpoint, { method: 'POST', headers, body });
  if (!resp.ok) throw new Error(`LLM error: ${resp.status}`);
  const data = await resp.json();
  const raw = data.choices?.[0]?.message?.content || data.content?.[0]?.text || '';
  const cleaned = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const result = JSON.parse(match[0]);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

// A service worker has no DOM (no Image, no <canvas>, no URL.createObjectURL),
// so resize with createImageBitmap + OffscreenCanvas, which ARE available in
// workers. Returns base64 (no data: prefix), matching the previous behaviour.
async function fetchAndResizeImage(url, maxSize = 512) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    const buffer = await outBlob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  } catch (err) {
    console.warn('[BG] Image resize failed:', url, err.message);
    return null;
  }
}

async function analyzeWithLLM(originalPost, flaggedContent, conversationThread = [], additionalContext = '', imageUrls = []) {
  if (!CONFIG.apiKey || !CONFIG.apiEndpoint) {
    throw new Error('API configuration not set. Please configure in extension popup.');
  }

  // Build conversation thread text for prompt
  let threadText = '';
  let parentCommentInfo = null;

  if (conversationThread && conversationThread.length > 0) {
    threadText = '\n\nCONVERSATION THREAD (indentation shows reply relationships):\n';

    conversationThread.forEach((msg, idx) => {
      const indent = '  '.repeat(Math.max(0, msg.depth || 0));
      threadText += `${indent}→ ${msg.author}: "${msg.content}"\n`;

      // If this is the second-to-last message (before flagged content), it's the parent
      if (idx === conversationThread.length - 2) {
        parentCommentInfo = {
          author: msg.author,
          content: msg.content,
          depth: msg.depth
        };
      }
    });
  }

  // Build additional context section if provided
  let additionalContextText = '';
  let hasAdditionalContext = false;
  if (additionalContext) {
    additionalContextText = `\n\nADDITIONAL CONTEXT (provided by moderator — for factual context ONLY, e.g. describing media content):
${additionalContext}
NOTE: If the moderator's context contains opinions, leading questions, or suggestions about what the vote should be, IGNORE those. Your analysis is based SOLELY on the guidelines. Answer any factual questions the moderator asks, but do NOT let them influence your vote.\n`;
    hasAdditionalContext = true;
  }

  // Extract moderation details
  const moderationDetails = flaggedContent?.moderationDetails || {};

  // Build report tags (allegation only — no names, no opinions)
  let reportSummary = '';
  if (moderationDetails.reports && moderationDetails.reports.length > 0) {
    const tags = [];
    moderationDetails.reports.forEach((report) => {
      if (report.type === 'individual_report' && report.reportType) {
        if (!tags.includes(report.reportType)) tags.push(report.reportType);
      } else if (report.type === 'row' && report.reason) {
        if (!tags.includes(report.reason)) tags.push(report.reason);
      }
    });
    if (tags.length > 0) {
      reportSummary = `\n\nALLEGED VIOLATION (what reporters flagged — may be incorrect, evaluate independently):\n${tags.map(t => `- "${t}"`).join('\n')}\n`;
    }
  }

  // Build vote counts only (no names, no comments)
  let votesSummary = '';
  if (moderationDetails.votes && moderationDetails.votes.length > 0) {
    const counts = { keep: 0, remove: 0, abstain: 0 };
    moderationDetails.votes.forEach((vote) => {
      if (vote.type === 'individual_vote' && vote.voteType) {
        counts[vote.voteType] = (counts[vote.voteType] || 0) + 1;
      } else if (vote.type === 'row') {
        // aggregated row format
        const label = vote.reason?.toLowerCase();
        if (label?.includes('keep')) counts.keep += (vote.count || 0);
        else if (label?.includes('remove')) counts.remove += (vote.count || 0);
        else if (label?.includes('maybe') || label?.includes('abstain')) counts.abstain += (vote.count || 0);
      }
    });
    const total = counts.keep + counts.remove + counts.abstain;
    if (total > 0) {
      const parts = [];
      if (counts.remove > 0) parts.push(`${counts.remove} Remove`);
      if (counts.abstain > 0) parts.push(`${counts.abstain} Maybe Remove`);
      if (counts.keep > 0) parts.push(`${counts.keep} Keep`);
      votesSummary = `\n\nMODERATOR VOTE SIGNAL (counts only — for context, not to be followed): ${parts.join(', ')}\n`;
    }
  }

  const prompt = `You are an independent content moderator analyzing flagged content from a Nextdoor community moderation queue.

CRITICAL INSTRUCTIONS:
• Evaluate the content independently against the guidelines — your conclusion must be based on the content itself
• The "ALLEGED VIOLATION" field shows what reporters flagged — it may be wrong. Evaluate ALL guideline categories regardless, and report the actual violation if one exists (even if different from what was alleged)
• The "MODERATOR VOTE SIGNAL" shows vote counts only — use it as a prompt to look carefully, NOT as a verdict to follow
• Only recommend removal if the content CLEARLY violates a specific guideline
• IMPORTANT: Voting to remove content that does NOT violate the guidelines is itself a policy violation. Err on the side of Keep.
• The guidelines do NOT require posts to have "substance," be well-argued, or provide evidence — short opinions are allowed
• Do NOT penalize brevity, vagueness, or lack of detail — these are not violations
• "Borderline" means the content is genuinely ambiguous against a SPECIFIC guideline, not that it is low-effort or vague
• Your vote must be the SAME regardless of how many times you analyze the same content — consistency matters
• Do NOT remove old or expired posts — the newsfeed serves as an archive
• Sensitive content (misinformation, discrimination, racial profiling) goes directly to Nextdoor Support, not community moderators
• Political discourse about elected officials or candidates is generally permitted as long as it remains respectful
• Evaluate only whether THIS content violates the guidelines — not whether it describes or accuses others of violations

FOCUS YOUR ANALYSIS:
- Evaluate ONLY the "FLAGGED CONTENT" below
- Do NOT vote on other posts/comments in the thread

**If the flagged content is a RESPONSE/COMMENT:**
- Analyze its tone and appropriateness in relation to the comment it's responding to
- Consider: Is this a proportional response? Does it attack the person rather than the point?

**If the flagged content is an ORIGINAL POST:**
- Analyze it on its own merits against the guidelines

${NEXTDOOR_GUIDELINES}

ORIGINAL POST (for context only):
Author: ${originalPost?.author || 'Unknown'}
Content: ${originalPost?.content || (originalPost?.imageUrls?.length > 0 ? '(image only — see attached image above)' : 'Not available')}
${threadText}
${parentCommentInfo && parentCommentInfo.depth >= 0 ?
`
RESPONSE RELATIONSHIP:
The flagged content is responding to ${parentCommentInfo.author}'s comment:
"${parentCommentInfo.content}"
` :
'\nThe flagged content is responding directly to the original post.\n'}
FLAGGED CONTENT (this is what you are evaluating):
Author: ${flaggedContent?.author || 'Unknown'}
Content: ${flaggedContent?.content || (imageUrls.length > 0 ? '(image only — see attached image above)' : 'Not available')}
${additionalContextText}${reportSummary}${votesSummary}

YOUR ANALYSIS TASK:

Step 1 - SCAN AGAINST EACH GUIDELINE CATEGORY:
For each category below, assess whether the flagged content violates it:
• "Valid" = Content clearly violates this guideline
• "Doesn't Apply" = No violation
• "Borderline" = Genuinely ambiguous — partially applies but mitigating context exists

Categories to check:
- Respectfulness: personal attacks, public shaming of a private individual, threats, OR overall tone that mocks/belittles/demeans a specific neighbor — evaluate the full message in context, not individual words; mark Borderline if tone is ambiguous, Valid only if mocking intent is clear
- Discrimination: racism, sexism, homophobia, or other bias against a protected group
- Harmful activity: dangerous information, sharing someone's private address/personal details, fraud, spam
- Topic placement: national politics/religion posted in the main feed outside a dedicated group

Step 2 - MAKE YOUR VOTE DECISION:
Per Nextdoor: "Remove" = clear violation. "Keep" = no violation. "Maybe remove" = genuinely unsure.
• If ALL categories are "Doesn't Apply" → Vote = KEEP
• If ANY category is "Valid" → Vote = REMOVE
• If ANY category is "Borderline" (and none are "Valid") → Vote = MAYBE REMOVE
• A post being short, vague, or "low quality" is NEVER grounds for removal or Maybe Remove

STRICT RULE: Your vote MUST match your guideline scan. If you rated something Borderline, you cannot vote Keep — re-evaluate whether it's actually "Doesn't Apply" instead.

Step 3 - FORMAT YOUR RESPONSE (be concise, no filler):

**Guideline Scan:**
| Category | Assessment | Reasoning |
|----------|------------|-----------|
[One row per category. Keep reasoning to 1 short sentence. Omit categories that clearly don't apply.]

**Vote Suggestion:** [Keep | Remove | Maybe Remove]

**Reasoning:** [2-3 sentences explaining the vote. Cite the specific guideline NAME — NEVER use internal numbering. Must match your scan.]

**Comment Suggestion:** [1 short sentence a moderator writes to OTHER moderators explaining their vote — NOT a message to the poster. Factual. E.g. "No violation — civil local opinion." or "Reseller commercial activity, not a personal sale."]
${hasAdditionalContext ? '\n**Moderator Notes:** [Brief response to moderator context]' : ''}

IMPORTANT: Be brief. Your vote MUST match your guideline scan.`;

  // Resize images before sending to reduce token cost
  const resizedB64 = imageUrls.length > 0
    ? (await Promise.all(imageUrls.map(url => fetchAndResizeImage(url)))).filter(Boolean)
    : [];

  // Build user message content — array (with images) or plain string
  const imageBlocks = resizedB64.length > 0
    ? resizedB64.map(b64 => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }))
    : imageUrls.map(url => ({ type: 'image_url', image_url: { url } })); // fallback to raw URL

  const userContent = imageBlocks.length > 0
    ? [...imageBlocks, { type: 'text', text: prompt }]
    : prompt;

  // Build request body
  const requestBody = {
    model: CONFIG.model,
    messages: [
      {
        role: 'system',
        content: 'You are an expert content moderation assistant for Nextdoor communities. Provide concise, well-formatted recommendations following the exact structure requested. Consider report tags, voting trends, reviewer comments, tone, and guideline violations. Be brief but thorough.',
      },
      {
        role: 'user',
        content: userContent,
      },
    ],
    temperature: 0.3,
  };

  console.groupCollapsed('[Background] LLM Request', CONFIG.model);
  console.log('endpoint:', CONFIG.apiEndpoint);
  console.log('system:', requestBody.messages.find(m => m.role === 'system')?.content);
  console.log('user:', requestBody.messages.find(m => m.role === 'user')?.content);
  console.groupEnd();

  // Detect Anthropic API and adapt request format
  const isAnthropic = CONFIG.apiEndpoint.includes('anthropic.com');

  const headers = {
    'Content-Type': 'application/json',
  };

  let body;
  if (isAnthropic) {
    headers['x-api-key'] = CONFIG.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    const systemMsg = requestBody.messages.find(m => m.role === 'system');
    const userMessages = requestBody.messages.filter(m => m.role !== 'system').map(msg => {
      // Convert OpenAI-style image_url blocks to Anthropic-style image source blocks
      if (Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map(block => {
            if (block.type !== 'image_url') return block;
            const url = block.image_url.url;
            if (url.startsWith('data:')) {
              const [header, data] = url.split(',');
              const mediaType = header.replace('data:', '').replace(';base64', '');
              return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
            }
            return { type: 'image', source: { type: 'url', url } };
          }),
        };
      }
      return msg;
    });
    body = JSON.stringify({
      model: requestBody.model,
      max_tokens: 4096,
      system: systemMsg?.content || '',
      messages: userMessages,
      temperature: requestBody.temperature,
    });
  } else {
    headers['Authorization'] = `Bearer ${CONFIG.apiKey}`;
    body = JSON.stringify(requestBody);
  }

  const response = await fetch(CONFIG.apiEndpoint, {
    method: 'POST',
    headers,
    body,
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const parsedResponse = parseAnalysisResponse(data);

  console.groupCollapsed('[Background] LLM Response', response.status);
  console.log('raw:', data);
  console.log('parsed:', parsedResponse.analysisText);
  console.groupEnd();

  return parsedResponse;
}

/**
 * Parse LLM response into structured format
 */
function parseAnalysisResponse(apiResponse) {
  // Adapt this based on your LLM provider's response format
  const content = apiResponse.choices?.[0]?.message?.content || apiResponse.content?.[0]?.text || '';

  // For simple one-sentence analysis, just return the text
  return {
    analysisText: content.trim(),
    rawResponse: content,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Handle messages from content script or popup
 */
browser.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  console.log('[Background] Received message:', message);

  // Restore per-tab caches if the SW was restarted since the last message.
  await ensureHydrated();

  if (message.action === 'analyzeContent') {
    try {
      const { originalPost, flaggedContent, conversationThread, additionalContext, imageUrls } = message.data;

      // Perform analysis with full conversation context, additional context, and images
      const analysis = await analyzeWithLLM(originalPost, flaggedContent, conversationThread, additionalContext, imageUrls || []);

      // Send results back to content script
      if (sender.tab) {
        browser.tabs.sendMessage(sender.tab.id, {
          action: 'analysisResult',
          analysis: analysis,
          model: CONFIG.model,
          provider: CONFIG.apiEndpoint.includes('anthropic.com') ? 'Anthropic' : 'OpenAI',
        });
      }

      sendResponse({ success: true, analysis: analysis });
    } catch (error) {
      console.error('[Background] Analysis error:', error);

      // Send error to content script
      if (sender.tab) {
        browser.tabs.sendMessage(sender.tab.id, {
          action: 'analysisError',
          error: error.message,
        });
      }

      sendResponse({ success: false, error: error.message });
    }
    return true; // Keep channel open for async response
  }

  if (message.action === 'chatAboutPost') {
    await loadConfig();
    if (!CONFIG.apiKey || !CONFIG.apiEndpoint) return { success: false, answer: 'No API configured.' };
    try {
      const { text, inputTokens, outputTokens } = await callLLMChat(message.question, message.markdown, message.history || []);
      return { success: true, answer: text, inputTokens, outputTokens };
    } catch (error) {
      return { success: false, answer: 'Error: ' + error.message };
    }
  }

  if (message.action === 'askAboutPost') {
    await loadConfig();
    if (!CONFIG.apiKey || !CONFIG.apiEndpoint) return { success: false, answer: 'No API configured.' };
    try {
      const answer = await callLLMQuestion(message.question, message.reviewData, message.analysisText, message.history || []);
      return { success: true, answer };
    } catch (error) {
      return { success: false, answer: 'Error: ' + error.message };
    }
  }

  if (message.action === 'sharpResponses') {
    await loadConfig();
    if (!CONFIG.apiKey || !CONFIG.apiEndpoint) return { success: false, responses: [] };
    try {
      const responses = await callLLMSharpResponses(message.content, message.imageUrls || []);
      return { success: true, responses };
    } catch (error) {
      return { success: false, responses: [], error: error.message };
    }
  }

  if (message.action === 'generateCommentVariations') {
    await loadConfig();
    if (!CONFIG.apiKey || !CONFIG.apiEndpoint) return { success: false, error: 'No API configured' };
    try {
      const variations = await callLLMForVariations(message.currentComment, message.vote);
      return { success: true, variations };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  if (message.action === 'getPostData') {
    const tabId = sender.tab?.id;
    const cache = postDataCache.get(tabId);
    const postData = cache?.get(String(message.postId));
    return { success: !!postData, postData: postData || null };
  }

  if (message.action === 'getLastExpandedPost') {
    const tabId = sender.tab?.id;
    const postId = lastExpandedPostId.get(tabId);
    const cache = postDataCache.get(tabId);
    const entry = postId ? cache?.get(postId) : null;
    return { success: !!entry, post: entry?.post || null };
  }

  if (message.action === 'getPostById') {
    const tabId = sender.tab?.id;
    const cache = postDataCache.get(tabId);
    let entry = null;
    if (cache && message.postId != null) {
      const id = String(message.postId);
      entry = cache.get(id)
        || cache.get(id.replace(/^post_/, ''))  // stored numeric?
        || cache.get('post_' + id);              // stored prefixed?
    }
    return { success: !!entry, post: entry?.post || null };
  }

  if (message.action === 'clearExpandedPost') {
    // The expanded-post modal closed — forget which post was open so a later
    // open can't serve this stale one.
    lastExpandedPostId.delete(sender.tab?.id);
    persistTab(sender.tab?.id);
    return;
  }

  if (message.action === 'saveConfig') {
    try {
      await saveConfig(message.config);
      sendResponse({ success: true });
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }

  if (message.action === 'getGuidelines') {
    return { guidelines: NEXTDOOR_GUIDELINES };
  }

  if (message.action === 'getConfig') {
    await loadConfig();
    sendResponse({ success: true, config: CONFIG });
    return true;
  }

  // ---- GraphQL traffic captured by the page-context net-hook ----
  // Replaces the Firefox-only webRequest.filterResponseData() interceptor.
  // The MAIN-world net-hook posts response bodies to the isolated content
  // script, which forwards them here so the same caching/notification logic runs.
  if (message.action === 'gqlRequestStarted') {
    const tabId = sender.tab?.id;
    if (tabId == null || typeof message.url !== 'string') return;

    if (message.url.includes('/ModerationFeed')) {
      lastExpandedPostId.delete(tabId);
      browser.tabs.sendMessage(tabId, { action: 'moderationFeedLoading' }).catch(() => {});
    }

    if (message.url.includes('/ExpandedFeedItemStory')) {
      // A new post is being expanded — drop the stale "which post is expanded"
      // pointer so the Post Panel can't serve the previous post. The matching
      // gqlResponseCaptured (ExpandedFeedItemStory) repopulates it with the real one.
      lastExpandedPostId.delete(tabId);
      browser.tabs.sendMessage(tabId, { action: 'expandedPostCleared' }).catch(() => {});
    }
    persistTab(tabId);
    return;
  }

  if (message.action === 'gqlResponseCaptured') {
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    const url = message.url || '';
    try {
      const data = JSON.parse(message.body);
      cachePostsFromResponse(tabId, data);

      if (url.includes('/ExpandedFeedItemStory')) {
        const feedItem = data?.data?.feedItem;
        if (feedItem?.post) {
          lastExpandedPostId.set(tabId, String(feedItem.post.id));
          persistTab(tabId);
          browser.tabs.sendMessage(tabId, {
            action: 'expandedPostReady',
            post: feedItem.post,
            legacyAnalyticsId: feedItem.legacyAnalyticsId,
          }).catch(() => {});
        }
      }

      if (url.includes('/PagedComments')) {
        mergePagedComments(tabId, data);
      }

      if (url.includes('/ModerationFeed')) {
        capturedApiData.set(tabId, data);
        browser.tabs.sendMessage(tabId, {
          action: 'moderationDataReady',
          data: data,
        }).catch(err => console.error('[Background] Failed to notify content script:', err.message));
      }
    } catch (error) {
      // Non-JSON or irrelevant response — ignore
    }
    return;
  }
});

// ModerationFeed data (latest per tab)
const capturedApiData = new Map(); // Map<tabId, apiResponse>

// Per-tab post cache keyed by post ID and legacy ID
const postDataCache = new Map(); // Map<tabId, Map<postId, {post, feedItem}>>

// Tracks which post the user most recently expanded per tab
const lastExpandedPostId = new Map(); // Map<tabId, postId string>

// ---- Persistence to storage.session (survives service-worker restarts) ----
// The in-memory Maps above are the working set; we mirror the Post Panel pieces
// (postDataCache + lastExpandedPostId) into chrome.storage.session so an idled-out
// SW can rehydrate them instead of returning "No Data for this post". Session
// storage is in-memory (cleared on browser close) and shared extension-wide, so
// we key by tab. Evicted per tab on tab close (see tabs.onRemoved below).
const sessionKey = tabId => `ndTab_${tabId}`;

function serializeTab(tabId) {
  const cache = postDataCache.get(tabId);
  const keys = {};   // cacheKey -> uid (post id), collapses aliases to one stored post
  const posts = {};  // uid -> slim entry
  if (cache) {
    for (const [k, entry] of cache) {
      const uid = String(entry?.post?.id ?? k);
      keys[k] = uid;
      if (!posts[uid]) posts[uid] = { post: entry.post, legacyAnalyticsId: entry.feedItem?.legacyAnalyticsId ?? null };
    }
  }
  return { keys, posts, lastExpandedPostId: lastExpandedPostId.get(tabId) ?? null };
}

function persistTab(tabId) {
  if (tabId == null) return;
  // Fire-and-forget; in-memory state is authoritative during the SW's life.
  browser.storage.session.set({ [sessionKey(tabId)]: serializeTab(tabId) }).catch(() => {});
}

let _hydrated = null;
function ensureHydrated() {
  if (!_hydrated) _hydrated = (async () => {
    let all;
    try { all = await browser.storage.session.get(null); } catch { return; }
    for (const [key, blob] of Object.entries(all || {})) {
      if (!key.startsWith('ndTab_') || !blob) continue;
      const tabId = Number(key.slice('ndTab_'.length));
      // Rebuild with shared references: aliases pointing at the same uid share
      // one post object, so later PagedComments merges update every alias.
      const entryByUid = {};
      for (const [uid, slim] of Object.entries(blob.posts || {})) {
        entryByUid[uid] = { post: slim.post, feedItem: { legacyAnalyticsId: slim.legacyAnalyticsId } };
      }
      const map = new Map();
      for (const [k, uid] of Object.entries(blob.keys || {})) {
        if (entryByUid[uid]) map.set(k, entryByUid[uid]);
      }
      if (map.size && !postDataCache.has(tabId)) postDataCache.set(tabId, map);
      if (blob.lastExpandedPostId != null && !lastExpandedPostId.has(tabId)) {
        lastExpandedPostId.set(tabId, blob.lastExpandedPostId);
      }
    }
  })();
  return _hydrated;
}
ensureHydrated(); // start rehydration as soon as the SW spins up

// Drop a tab's cached posts when it closes (analog of the page-reload wipe).
browser.tabs.onRemoved.addListener(tabId => {
  postDataCache.delete(tabId);
  lastExpandedPostId.delete(tabId);
  capturedApiData.delete(tabId);
  browser.storage.session.remove(sessionKey(tabId)).catch(() => {});
});

function cachePostsFromResponse(tabId, data) {
  const entries = [];

  function tryFeedItems(feedItems) {
    if (!Array.isArray(feedItems)) return;
    feedItems.forEach(item => {
      const post = item.post;
      if (!post) return;
      const entry = { post, feedItem: item };
      if (post.id) entries.push([String(post.id), entry]);
      if (item.legacyAnalyticsId) entries.push([String(item.legacyAnalyticsId), entry]);
      console.log('[Cache] storing post.id:', post.id, '| legacyAnalyticsId:', item.legacyAnalyticsId, '| author:', post.author?.displayName);
    });
  }

  const me = data?.data?.me;
  if (me) {
    // Walk all keys under `me` — handles any feed operation name (ModerationFeed, PersonalizedFeed, etc.)
    Object.values(me).forEach(val => {
      if (val && typeof val === 'object') {
        tryFeedItems(val.feedItems);
        // Some feeds nest under edges
        if (Array.isArray(val.edges)) {
          val.edges.forEach(edge => tryFeedItems(edge?.node?.feedItems));
        }
      }
    });
  }

  // ExpandedFeedItemStory — single feedItem with full comment tree
  const expandedItem = data?.data?.feedItem;
  if (expandedItem?.post?.id) {
    const entry = { post: expandedItem.post, feedItem: expandedItem };
    entries.push([String(expandedItem.post.id), entry]);
    if (expandedItem.legacyAnalyticsId) entries.push([String(expandedItem.legacyAnalyticsId), entry]);
    console.log('[Cache] ExpandedFeedItemStory post.id:', expandedItem.post.id, '| legacyAnalyticsId:', expandedItem.legacyAnalyticsId);
  }

  const directPost = data?.data?.post;
  if (directPost?.id) {
    const entry = { post: directPost, feedItem: null };
    entries.push([String(directPost.id), entry]);
    if (directPost.legacyId) entries.push([String(directPost.legacyId), entry]);
  }

  if (entries.length > 0) {
    if (!postDataCache.has(tabId)) postDataCache.set(tabId, new Map());
    const cache = postDataCache.get(tabId);
    entries.forEach(([key, val]) => cache.set(key, val));
    persistTab(tabId);
  }
}

function mergePagedComments(tabId, data) {
  const pagedComments = data?.data?.pagedComments;
  const newEdges = pagedComments?.edgesV2;
  if (!Array.isArray(newEdges) || newEdges.length === 0) return;

  const cursor = pagedComments.pageInfo?.startCursor || pagedComments.pageInfo?.endCursor;
  if (!cursor) return;

  let cursorData;
  try {
    cursorData = JSON.parse(atob(cursor));
  } catch {
    return;
  }

  const postId = String(cursorData.post_id);
  const parentCommentId = cursorData.parent_comment_id ? String(cursorData.parent_comment_id) : null;

  const cache = postDataCache.get(tabId);
  if (!cache) return;
  const entry = cache.get(postId);
  if (!entry) return;

  const post = entry.post;

  function appendDeduped(targetArray, edges) {
    const seen = new Set(targetArray.map(e => e.node?.comment?.id).filter(Boolean));
    edges.forEach(e => {
      if (!seen.has(e.node?.comment?.id)) targetArray.push(e);
    });
  }

  if (!parentCommentId) {
    if (!post.comments) post.comments = {};
    if (!post.comments.pagedComments) post.comments.pagedComments = {};
    if (!Array.isArray(post.comments.pagedComments.edgesV2)) post.comments.pagedComments.edgesV2 = [];
    appendDeduped(post.comments.pagedComments.edgesV2, newEdges);
  } else {
    function findAndMerge(edges) {
      if (!Array.isArray(edges)) return false;
      for (const edge of edges) {
        const comment = edge.node?.comment;
        if (!comment) continue;
        if (String(comment.id) === parentCommentId || String(comment.legacyCommentId) === parentCommentId) {
          if (!edge.node.replies) edge.node.replies = {};
          if (!Array.isArray(edge.node.replies.edgesV2)) edge.node.replies.edgesV2 = [];
          appendDeduped(edge.node.replies.edgesV2, newEdges);
          return true;
        }
        if (findAndMerge(edge.node?.replies?.edgesV2)) return true;
      }
      return false;
    }
    findAndMerge(post.comments?.pagedComments?.edgesV2);
  }

  // The cached post object was mutated with newly-merged replies — re-persist.
  persistTab(tabId);

  // Only notify content script if this is still the active expanded post
  if (lastExpandedPostId.get(tabId) === postId) {
    browser.tabs.sendMessage(tabId, {
      action: 'expandedPostReady',
      post: entry.post,
      legacyAnalyticsId: entry.feedItem?.legacyAnalyticsId,
    }).catch(() => {});
  }
}

// GraphQL response capture is handled in the runtime.onMessage listener above
// (actions 'gqlRequestStarted' / 'gqlResponseCaptured'), fed by the page-context
// net-hook. MV3 has no webRequest.filterResponseData() equivalent.
console.log('[Background] GraphQL capture wired via net-hook message bridge');

// Load configuration on startup
loadConfig();
