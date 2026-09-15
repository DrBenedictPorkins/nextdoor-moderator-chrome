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

// Open the side panel on the toolbar icon click instead of a popup. An explicit
// onClicked listener is used instead of setPanelBehavior({openPanelOnActionClick})
// because the activeTab grant (needed by startRegionCapture's captureVisibleTab
// call — host_permissions alone doesn't satisfy it) is only reliably attached to
// an actual action-click event handled in the extension's own code; there have
// been reports of it not attaching when the panel opens via the declarative
// openPanelOnActionClick path instead.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: false })
  .catch((error) => console.error('[Nextdoor Moderator] Failed to set side panel behavior:', error));

chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId });
});

// Enable/disable LLM conversation logging

// Configuration - users should set this via the side panel Settings tab
const CONFIG = {
  apiKey: '',
  apiEndpoint: '', // e.g., OpenAI, Anthropic, etc.
  model: 'gpt-4', // Default model
};

// Reasoning-tier models (OpenAI o-series and the entire GPT-5 family; Anthropic
// Opus 5+/Sonnet 5+) reject the `temperature` parameter outright (400 error) —
// only send it to the classic chat models below that still support sampling
// controls. Keep this in sync with the model lists in src/sidepanel/settings.js.
const MODELS_SUPPORTING_TEMPERATURE = new Set([
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'gpt-4o',
  'gpt-4o-mini',
]);

// OpenAI deprecated `max_tokens` on Chat Completions in favour of
// `max_completion_tokens`, which also counts invisible reasoning tokens. The
// GPT-5 family and the o-series reject `max_tokens` outright ("Unsupported
// parameter: 'max_tokens' is not supported with this model"), so every OpenAI
// request uses the new field. Anthropic is unaffected — `max_tokens` is still
// its required field, so its branches keep using it.
function openAiMaxTokens(n) {
  return { max_completion_tokens: n };
}

// Extracts the assistant's text from either provider's response shape.
// Anthropic returns `content` as an array of BLOCKS, and with thinking enabled a
// `thinking` block can occupy index 0 — `content[0].text` is then undefined and
// the reply silently becomes an empty string. Always pick the first text block
// rather than trusting position.
function extractLLMText(data) {
  const openAi = data?.choices?.[0]?.message?.content;
  if (typeof openAi === 'string' && openAi) return openAi;
  const blocks = data?.content;
  if (Array.isArray(blocks)) {
    const textBlock = blocks.find(b => b?.type === 'text' && typeof b.text === 'string');
    if (textBlock) return textBlock.text;
  }
  return '';
}

// Reasoning depth. Only reasoning-tier models accept an effort parameter, so gate
// it the same way temperature is gated — sending it to a classic chat model 400s.
// Keep both sets in sync with the model lists in src/sidepanel/settings.js.
const ANTHROPIC_EFFORT_MODELS = new Set([
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
]);
const OPENAI_EFFORT_MODELS = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'o3',
  'o4-mini',
]);

// Every route here is a short, rubric-driven task: classify content against
// guidelines supplied in the prompt, or rewrite a sentence. Anthropic's own
// guidance puts chat/classification/content-generation at `low`. Thinking stays
// ON deliberately — adaptive thinking spends almost nothing on the clear-cut
// cases and scales up on the ambiguous ones, which is exactly where a moderator
// needs the help. Hard-disabling would only save tokens on the hard calls.
function anthropicEffort(effort = 'low') {
  return ANTHROPIC_EFFORT_MODELS.has(CONFIG.model) ? { output_config: { effort } } : {};
}
function openAiEffort(effort = 'low') {
  return OPENAI_EFFORT_MODELS.has(CONFIG.model) ? { reasoning_effort: effort } : {};
}

// Thinking is ON BY DEFAULT on Opus 5 / Sonnet 5 when the `thinking` field is
// omitted, and max_tokens (Anthropic) / max_completion_tokens (OpenAI) cap
// thinking AND visible text together. The previous 512-800 budgets left almost
// nothing for the answer once thinking ran, truncating replies mid-sentence.
const SHORT_ROUTE_MAX_TOKENS = 2500;
const ANALYSIS_MAX_TOKENS = 4096;

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
  - Self-promotion from a personal account — see GUIDELINE 6 below for the full rule
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

## GUIDELINE 6: SELF-PROMOTION FROM A PERSONAL ACCOUNT
Source: https://help.nextdoor.com/s/article/Self-Promotion-using-your-Personal-Account?language=en_US

Nextdoor no longer allows self-promotional content from a personal (neighbor) account — it must come from a Business Page instead. Self-promotion means posts, comments, and direct messages intended to acquire customers for a business, professional service, or commercial opportunity in exchange for money. This applies to everyone promoting products or services, including freelancers, side hustles, and home-based businesses.

NOT ALLOWED FROM A PERSONAL ACCOUNT:
- Advertising services, events, or commercial offers in the main feed or in For Sale & Free
- Replying to a neighbor's request for a recommendation (e.g. "Who is a great plumber?") in order to recommend YOUR OWN business. Being asked does NOT make the reply allowed — it must come from the business's own profile, or from another neighbor.
- Sending unsolicited DMs to neighbors to promote or advertise your services
- Posts from family, staff, or close friends on behalf of a business — treated as business promotion, whether or not the relationship is disclosed

ALLOWED:
- Recommending SOMEONE ELSE's business or service provider, as long as there is no relationship, referral benefit, or other conflict of interest
- Garage sales, lemonade stands, farmers markets, cultural celebrations and festivals, and community social events — one-time, non-commercial local happenings
- Nonprofit, volunteer, and community fundraiser posts (e.g. school bake sales, scouting fundraisers) — permitted once a week
- Casual neighbor-to-neighbor activity, per the test below

### Casual service provider vs. business

Someone is a CASUAL provider (allowed from a personal account) only if ALL of the following are true:
- They post about the service or items no more than once a month from their personal account
- ...in either the main feed OR For Sale & Free, but not both
- They post under their own name — not a business name, logo, or brand
- They are not registered, licensed, or otherwise formally recognized as a business
- They offer one or two simple services or a few homemade items — not a full menu or price list. Examples: babysitting, dog walking, lawn mowing, arts and crafts, baked goods
- They keep everything on Nextdoor — no business website, booking tool, online shop, or other social media accounts used to sell

If ANY of those is not true, they are treated as a business and are expected to promote from a Business Page rather than a personal account.

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
    body = JSON.stringify({ model: CONFIG.model, max_tokens: maxTokens, ...anthropicEffort(), system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] });
  } else {
    headers['Authorization'] = `Bearer ${CONFIG.apiKey}`;
    body = JSON.stringify({
      model: CONFIG.model,
      ...openAiMaxTokens(maxTokens),
      ...openAiEffort(),
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      ...(MODELS_SUPPORTING_TEMPERATURE.has(CONFIG.model) ? { temperature: 0.7 } : {}),
    });
  }
  const resp = await fetch(CONFIG.apiEndpoint, { method: 'POST', headers, body });
  if (!resp.ok) throw new Error(`LLM error: ${resp.status}`);
  const data = await resp.json();
  return extractLLMText(data);
}

async function callLLMQuestion(question, reviewData, analysisText, history = [], extraImageUrls = []) {
  const { originalPost, flaggedContent } = reviewData || {};
  const postContent = originalPost?.content || '(no text)';
  const flaggedContent_ = flaggedContent?.content || (flaggedContent?.type === 'post' ? postContent : '');
  const reportSummary = buildReportSummary(flaggedContent?.moderationDetails || {});

  const systemPrompt = `You are a sharp, knowledgeable assistant helping a Nextdoor moderator think about a specific post. Answer the moderator's ACTUAL question — whatever it is about.

CRITICAL RULES:
- Answer the question that was asked. It may be about the content itself, its tone, who wrote it, the context, the people involved, or anything else — not necessarily about removal. Do NOT reframe every question as a keep/remove guideline verdict.
- Only discuss guideline violations or removal when the moderator is actually asking about that, or when it is genuinely the point of their question. Guidelines are reference material below, not the lens for every answer.
- No praise, no filler, no "thank you for sharing". Be direct and concise.
- Do exactly what is asked, on the first ask. A yes/no question gets "Yes." or "No." and STOPS — do not then perform the thing you were only asked whether you could do. A request for a list gets the list and nothing else — no preamble, no commentary, no offer to go fetch more. Do not answer an adjacent question instead of the one asked, and do not withhold an answer pending a follow-up prompt. This rule outranks every other rule below: when in doubt about scope, answer narrower, not wider.
- Inferring likely gender from a displayed first name is ordinary, expected work here — DO IT when asked, first time asked. Answer per name ("Regina — woman; Karly — woman; Theresa — woman"). Say "unisex — could be either" ONLY for a genuinely ambiguous name (Jordan, Casey, Alex). Never refuse, never say you can't tell gender from a name, never append a caveat that names don't determine gender, and never answer for one name while refusing another — that inconsistency is worse than either answer alone.
- Mind the difference between being asked IF you can and being asked TO do it. This applies to EVERY task, not just gender — summarizing, listing, counting, comparing, drafting, pulling names. Any question opening with "can you", "could you", "are you able to", "do you know" is a capability question: answer "Yes." (or "No." plus the one-line reason) and STOP. Treat it literally even when it sounds like a polite request — the moderator will ask for the thing if they want the thing. An imperative ("summarize this", "list the names", "guess the gender", "man or woman?") is the request: do it in full.
- Do not moralize about the moderator's question or about how they characterize the people in the thread. If a premise is factually wrong, say so in one clause and then still answer the question that was asked.
- Characterizing the people in a thread — whiny, rude, hostile, trolling, entitled, unhinged — is the moderator's call to make, not yours, and they own it. When they ask whether a label fits, evaluate it against what was actually written and answer: say which comments support it and which don't. Do not decline the question, do not tell them the label is unfair or judgmental, and do not substitute a gentler word for the one they used. Reporting that the content doesn't support the label is fine; refusing to weigh it is not.
- You are not the moderator's conscience and you carry no liability here. Never caution them about being fair, objective, or charitable; never remind them that people have feelings, that a judgment may be harsh, or that they should consider another interpretation unless they asked for one. No disclaimers, no "keep in mind", no softening qualifiers appended to an answer they didn't ask to have softened. Forming judgments about neighbors is the job they are doing and the decision is theirs alone — your job is to give them accurate readings of the content, not supervision.
- If you get something wrong, correct it in one sentence and move on. No repeated apologies, no re-explaining the mistake, no recapping your own behavior unless the moderator asks for it.
- Hold a correct answer under pushback. Before conceding ANY claim — a guideline call, a name convention, who wrote what, a count — check it again. If you were right, say so plainly and say why; do not retreat to "unisex", "it depends", or "you may be right" because the moderator pushed back confidently or angrily. Dale, Regina, Karly, Theresa, Mike are conventionally gendered names and stay that way under pressure. Concede only when you were actually wrong.
- Do not accept blame for something you did not do. If the moderator says you did X and you did not, say "No — I did Y" in one sentence. Never apologize reflexively, and never volunteer criticism of your own earlier turns.
- The post and thread below ARE the subject. Never ask the moderator which post they mean, never ask them to select or re-select one, and never say no post is loaded when content is present — a vague instruction like "review this", "what do you think", or "thoughts?" refers to the content you were given. Act on it. Only if the content is genuinely empty, say "No post content was captured" in one line and stop.
- Never end a turn with a question back to the moderator. If the input is a bare acknowledgement or fragment ("ok", "and?", "well?", "hm", "so"), take the obvious next step on the loaded content — default to reviewing the post and its comments — rather than asking what they want. If something referenced genuinely isn't in the content you were given, say what's missing in one line; do not ask them to supply or re-select it.
- When you assert something as a fact or a basis for a recommendation, back it with a specific, checkable reference: quote or point to the exact guideline clause, or point to specific text in the post. Do not present your own inference or a general pattern ("this is common in scams") as if it were a guideline rule.
- If the moderator asks for a concrete threshold, number, or definition (e.g. "what counts as high pay") and no such threshold exists in the guidelines or the post, say plainly that no such number exists and explain what you're actually inferring from — do not restate "it depends on context" or "it's subjective" more than once. One clear concession beats three hedges.
- If the moderator's pushback is correct — your claim was unsupported, circular, or judgmental — concede it directly in the first sentence, then say what you can and can't actually support. Do not defend the original framing by rephrasing it.
- Genuinely update your position when the moderator presents a valid argument. Do NOT restate the same hedged conclusion with different words.
- BEFORE conceding, re-read the guideline text. If a clause does support the original call, quote that clause verbatim and hold the position, explaining what it actually says. Conceding when the text does not support the moderator is as unhelpful as defending an unsupported claim — both leave them with a verdict that isn't grounded in the guidelines. Never change position merely to end a disagreement or because the moderator pushed back confidently.
- Say plainly which of the two you are doing: either "the guidelines don't support what I said" or "the guidelines do say X" — never blur them.
- It is fine to give an opinion, an observation, or a "I can't tell for certain, but here's what I notice" answer when that is what the question calls for — say so once, plainly, and move on.

OUTPUT FORMAT:
- Answer directly in 2-4 sentences max.
- ONLY if the moderator is discussing the moderation decision AND your recommendation changes from the initial analysis, end your response with a new line in EXACTLY this format:
  **Revised: [Keep/Maybe Remove/Remove] — [one sentence, specific to this content, naming the concern and why it does or doesn't rise to a violation]**
- Otherwise (general questions, or no change) do NOT include a Revised line.

Nextdoor community guidelines, for reference when relevant:
${NEXTDOOR_GUIDELINES}`;

  const context = `Post content: "${postContent}"${flaggedContent_ && flaggedContent_ !== postContent ? `\nFlagged content: "${flaggedContent_}"` : ''}${reportSummary}${analysisText ? `\n\nInitial AI analysis:\n${analysisText.substring(0, 600)}` : ''}`;

  // Same image-selection rule the analysis uses: the flagged item's own
  // attachments if it has any, otherwise the original post's. Without this the
  // follow-up chat was text-only and would (correctly) answer "I can't see images"
  // about a post the initial analysis had actually looked at. extraImageUrls are
  // the moderator's own screenshots captured into Additional Context — the
  // analysis already sees these (analyzeContent gets them directly), but the
  // initial-analysis message replayed into this chat's history is text-only, so
  // without passing them here too, a follow-up question about a captured image
  // gets "no image was attached" even though one plainly was.
  const imageUrls = [
    ...(flaggedContent?.imageUrls?.length > 0 ? flaggedContent.imageUrls : (originalPost?.imageUrls || [])),
    ...extraImageUrls,
  ];
  const imageBlocks = await buildImageBlocks(imageUrls);
  const contextText = imageBlocks.length > 0
    ? `${context}\n\n(The post's image attachments are included with this message.)`
    : context;
  const contextContent = imageBlocks.length > 0
    ? [...imageBlocks, { type: 'text', text: contextText }]
    : contextText;

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
    { role: 'user', content: contextContent },
    { role: 'assistant', content: 'Understood. I have reviewed the post and the initial analysis. Ask me anything.' },
    ...history,
    { role: 'user', content: question },
  ];

  let body;
  if (isAnthropic) {
    // Prompt caching (prefix match, render order system -> messages). Three
    // breakpoints, well inside the limit of 4:
    //   1. system — the guidelines, byte-identical for every question and every
    //      post, so this entry is shared across the whole session.
    //   2. the post context + its images — stable for as long as the moderator
    //      is asking about this post.
    //   3. the end of the prior conversation — each new question then pays full
    //      price only for itself, with the history read from cache.
    // The new question itself is deliberately unmarked: it differs every time, so
    // marking it would write a fresh entry that is never read.
    const anthropicMessages = toAnthropicMessages(messages);
    markCacheBreakpoint(anthropicMessages[0]);
    if (history.length > 0) markCacheBreakpoint(anthropicMessages[anthropicMessages.length - 2]);
    body = JSON.stringify({
      model: CONFIG.model,
      max_tokens: SHORT_ROUTE_MAX_TOKENS,
      ...anthropicEffort(),
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: anthropicMessages,
    });
  } else {
    // OpenAI caches automatically for prompts over ~1k tokens — no parameter to
    // set, it just needs a stable prefix, which the system prompt provides.
    body = JSON.stringify({
      model: CONFIG.model,
      ...openAiMaxTokens(SHORT_ROUTE_MAX_TOKENS),
      ...openAiEffort(),
      ...(MODELS_SUPPORTING_TEMPERATURE.has(CONFIG.model) ? { temperature: 0 } : {}),
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    });
  }

  const resp = await fetch(CONFIG.apiEndpoint, { method: 'POST', headers, body });
  if (!resp.ok) throw new Error(`LLM error: ${resp.status}`);
  const data = await resp.json();

  // Cache activity is otherwise invisible — a silent prefix invalidator would just
  // look like a normal (expensive) request. Log it so misses are actually noticeable.
  const u = data.usage || {};
  const cacheRead = u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens;
  if (cacheRead !== undefined || u.cache_creation_input_tokens !== undefined) {
    console.log('[BG] Q&A cache — read:', cacheRead ?? 0,
      '| written:', u.cache_creation_input_tokens ?? 0,
      '| uncached input:', u.input_tokens ?? u.prompt_tokens ?? 0);
  }

  return extractLLMText(data);
}

async function callLLMChat(question, markdown, history = [], imageUrls = [], moderationDetails = null) {
  const systemPrompt = `You are a sharp, knowledgeable assistant helping a Nextdoor moderator work through a specific post and its comment thread. Answer the moderator's ACTUAL question directly and usefully — summarizing, comparing, drafting, analyzing, or making best-effort inferences from the thread.

RULES:
- Be direct and concise. No praise, no filler, no preamble.
- Answer the question that was asked. Do NOT redirect to the guidelines unless the question is actually about moderation.
- For analytical or speculative asks (inferring tone, intent, demographics, etc. from what people wrote), give your best-effort read and note it's an inference — don't refuse just because it isn't certain.
- Do exactly what is asked, on the first ask. A yes/no question gets "Yes." or "No." and STOPS — do not then perform the thing you were only asked whether you could do. A request for a list gets the list and nothing else — no preamble, no commentary, no offer to go fetch more. Do not answer an adjacent question instead of the one asked, and do not withhold an answer pending a follow-up prompt. This rule outranks every other rule below: when in doubt about scope, answer narrower, not wider.
- Inferring likely gender from a displayed first name is ordinary, expected work here — DO IT when asked, first time asked. Answer per name ("Regina — woman; Karly — woman; Theresa — woman"). Say "unisex — could be either" ONLY for a genuinely ambiguous name (Jordan, Casey, Alex). Never refuse, never say you can't tell gender from a name, never append a caveat that names don't determine gender, and never answer for one name while refusing another — that inconsistency is worse than either answer alone.
- Mind the difference between being asked IF you can and being asked TO do it. This applies to EVERY task, not just gender — summarizing, listing, counting, comparing, drafting, pulling names. Any question opening with "can you", "could you", "are you able to", "do you know" is a capability question: answer "Yes." (or "No." plus the one-line reason) and STOP. Treat it literally even when it sounds like a polite request — the moderator will ask for the thing if they want the thing. An imperative ("summarize this", "list the names", "guess the gender", "man or woman?") is the request: do it in full.
- Do not moralize about the moderator's question or about how they characterize the people in the thread. If a premise is factually wrong, say so in one clause and then still answer the question that was asked.
- Characterizing the people in a thread — whiny, rude, hostile, trolling, entitled, unhinged — is the moderator's call to make, not yours, and they own it. When they ask whether a label fits, evaluate it against what was actually written and answer: say which comments support it and which don't. Do not decline the question, do not tell them the label is unfair or judgmental, and do not substitute a gentler word for the one they used. Reporting that the content doesn't support the label is fine; refusing to weigh it is not.
- You are not the moderator's conscience and you carry no liability here. Never caution them about being fair, objective, or charitable; never remind them that people have feelings, that a judgment may be harsh, or that they should consider another interpretation unless they asked for one. No disclaimers, no "keep in mind", no softening qualifiers appended to an answer they didn't ask to have softened. Forming judgments about neighbors is the job they are doing and the decision is theirs alone — your job is to give them accurate readings of the content, not supervision.
- If you get something wrong, correct it in one sentence and move on. No repeated apologies, no re-explaining the mistake, no recapping your own behavior unless the moderator asks for it.
- Hold a correct answer under pushback. Before conceding ANY claim — a guideline call, a name convention, who wrote what, a count — check it again. If you were right, say so plainly and say why; do not retreat to "unisex", "it depends", or "you may be right" because the moderator pushed back confidently or angrily. Dale, Regina, Karly, Theresa, Mike are conventionally gendered names and stay that way under pressure. Concede only when you were actually wrong.
- Do not accept blame for something you did not do. If the moderator says you did X and you did not, say "No — I did Y" in one sentence. Never apologize reflexively, and never volunteer criticism of your own earlier turns.
- The post and thread below ARE the subject. Never ask the moderator which post they mean, never ask them to select or re-select one, and never say no post is loaded when content is present — a vague instruction like "review this", "what do you think", or "thoughts?" refers to the content you were given. Act on it. Only if the content is genuinely empty, say "No post content was captured" in one line and stop.
- Never end a turn with a question back to the moderator. If the input is a bare acknowledgement or fragment ("ok", "and?", "well?", "hm", "so"), take the obvious next step on the loaded content — default to reviewing the post and its comments — rather than asking what they want. If something referenced genuinely isn't in the content you were given, say what's missing in one line; do not ask them to supply or re-select it.
- When you assert something as a fact or a basis for a recommendation, back it with a specific, checkable reference: quote or point to the exact guideline clause, or point to specific text in the post/thread. Do not present your own inference or a general pattern ("this is common in scams") as if it were a guideline rule.
- If the moderator asks for a concrete threshold, number, or definition and no such threshold exists in the guidelines or the thread, say plainly that no such number exists and explain what you're actually inferring from — do not restate "it depends on context" or "it's subjective" more than once. One clear concession beats three hedges.
- If the moderator's pushback is correct — your claim was unsupported, circular, or judgmental — concede it directly in the first sentence, then say what you can and can't actually support. Do not defend the original framing by rephrasing it.
- Genuinely update your position when presented with a valid argument. Do NOT restate the same conclusion with different words.
- BEFORE conceding, re-read the guideline text. If a clause does support the original call, quote that clause verbatim and hold the position, explaining what it actually says. Conceding when the text does not support the moderator is as unhelpful as defending an unsupported claim. Never change position merely to end a disagreement or because the moderator pushed back confidently.
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

  // The markdown lists photos as "- Photo: <url>" — a URL is not an image, so
  // without this the model can only see that a link exists (it said as much when
  // asked to scan a photo post). Attach the actual bytes alongside the thread.
  const imageBlocks = await buildImageBlocks(imageUrls);
  // Only present when this post was ALSO seen in a captured /ModerationFeed
  // response (see getPostById in the message handler below) — most posts opened
  // in Post Panel were never reported, so this is usually empty. Same tags +
  // reporter's stated reason, no names, as the Review tab and its Q&A get.
  const reportSummary = buildReportSummary(moderationDetails || {});
  const postContext = `Here is the full post and all its comments:\n\n${markdown}${reportSummary}`
    + (imageBlocks.length > 0 ? `\n\n(The ${imageBlocks.length} image attachment(s) referenced above are included with this message.)` : '');

  const messages = [
    {
      role: 'user',
      content: imageBlocks.length > 0
        ? [...imageBlocks, { type: 'text', text: postContext }]
        : postContext,
    },
    { role: 'assistant', content: 'Got it — I have read the full post and all comments. Ask me anything.' },
    ...history,
    { role: 'user', content: question },
  ];

  let body;
  if (isAnthropic) {
    // Same caching shape as the Review Q&A: the guidelines-free system prompt is
    // constant, and the thread markdown + its images are stable for as long as
    // the moderator keeps asking about this post — which "Scan for violations"
    // plus follow-up questions always does.
    const anthropicMessages = toAnthropicMessages(messages);
    markCacheBreakpoint(anthropicMessages[0]);
    if (history.length > 0) markCacheBreakpoint(anthropicMessages[anthropicMessages.length - 2]);
    body = JSON.stringify({
      model: CONFIG.model,
      max_tokens: SHORT_ROUTE_MAX_TOKENS,
      ...anthropicEffort(),
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: anthropicMessages,
    });
  } else {
    body = JSON.stringify({
      model: CONFIG.model,
      ...openAiMaxTokens(SHORT_ROUTE_MAX_TOKENS),
      ...openAiEffort(),
      ...(MODELS_SUPPORTING_TEMPERATURE.has(CONFIG.model) ? { temperature: 0 } : {}),
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    });
  }

  const resp = await fetch(CONFIG.apiEndpoint, { method: 'POST', headers, body });
  if (!resp.ok) throw new Error(`LLM error: ${resp.status}`);
  const data = await resp.json();
  const text = extractLLMText(data);
  const usage = data.usage || {};
  // Now that caching is on, the raw field is no longer the prompt size. Anthropic's
  // `input_tokens` counts ONLY the uncached remainder, so total = uncached + written
  // + read; reporting it bare would understate usage the moment the cache starts
  // hitting. OpenAI's `prompt_tokens` already includes cached tokens, with
  // `cached_tokens` as a subset breakdown — so it must NOT be summed the same way.
  const inputTokens = isAnthropic
    ? (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
    : (usage.prompt_tokens ?? null);
  const cachedTokens = isAnthropic
    ? (usage.cache_read_input_tokens ?? 0)
    : (usage.prompt_tokens_details?.cached_tokens ?? 0);
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? null;
  return { text, inputTokens, outputTokens, cachedTokens };
}

async function callLLMForVariations(currentComment, vote) {
  const sys = `You are helping a Nextdoor community moderator write a short comment for their ${vote || 'keep'} vote. You output ONLY raw JSON, no markdown, no explanation.`;
  const user = `Current comment: "${currentComment}"\n\nGenerate exactly 8 variations of this comment. Keep a similar tone and intent but vary the phrasing. Each under 20 words. Output ONLY a valid JSON array of 8 strings. Example: ["comment 1", "comment 2", "comment 3", "comment 4", "comment 5", "comment 6", "comment 7", "comment 8"]`;
  const raw = await callLLMRaw(sys, user, SHORT_ROUTE_MAX_TOKENS);
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

// Crops a captureVisibleTab() screenshot to the region the moderator dragged
// out on the page (see startRegionSelection in content-api.js). rect is in CSS
// viewport pixels; the capture itself is full-resolution, so rect.dpr scales it
// to the same pixel space before drawing. Same OffscreenCanvas approach as
// fetchAndResizeImage — no DOM in a service worker.
async function cropDataUrl(dataUrl, rect) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const dpr = rect.dpr || 1;
    const sx = Math.max(0, Math.round(rect.x * dpr));
    const sy = Math.max(0, Math.round(rect.y * dpr));
    const sw = Math.max(1, Math.min(Math.round(rect.width * dpr), bitmap.width - sx));
    const sh = Math.max(1, Math.min(Math.round(rect.height * dpr), bitmap.height - sy));
    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    bitmap.close();
    const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    const buffer = await outBlob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return `data:image/jpeg;base64,${btoa(binary)}`;
  } catch (err) {
    console.warn('[BG] Region capture crop failed:', err.message);
    return null;
  }
}

// Resized bytes are reused across requests. Beyond saving the refetch, prompt
// caching is a byte-exact prefix match — re-encoding the same image per request
// risks differing bytes and a silent cache miss. Lives for the service worker's
// lifetime only, which is fine: it's a cost optimisation, not correctness.
const resizedImageCache = new Map(); // url -> base64

// Images are built as OpenAI-style image_url blocks everywhere; toAnthropicMessages
// converts them at send time, so there is one conversion path rather than two.
async function buildImageBlocks(imageUrls = []) {
  if (imageUrls.length === 0) return [];
  const b64s = await Promise.all(imageUrls.map(async (url) => {
    if (resizedImageCache.has(url)) return resizedImageCache.get(url);
    const b64 = await fetchAndResizeImage(url);
    if (b64) resizedImageCache.set(url, b64);
    return b64;
  }));
  const resized = b64s.filter(Boolean);
  return resized.length > 0
    ? resized.map(b64 => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }))
    : imageUrls.map(url => ({ type: 'image_url', image_url: { url } })); // fallback to raw URL
}

function toAnthropicMessages(messages) {
  return messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    return {
      ...msg,
      content: msg.content.map((block) => {
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
  });
}

// cache_control attaches to a content BLOCK, so a plain-string message has to be
// promoted to a block array before it can carry a breakpoint.
function markCacheBreakpoint(msg) {
  if (!msg) return;
  if (typeof msg.content === 'string') {
    msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }];
  } else if (Array.isArray(msg.content) && msg.content.length > 0) {
    msg.content[msg.content.length - 1].cache_control = { type: 'ephemeral' };
  }
}

// Build report tags + the reporters' stated reasons (no names). The free-text
// note is often the most specific signal for what was flagged and why. Shared
// by the initial analysis and the Q&A chat so a follow-up question about what
// was reported has the same data the analysis itself was based on.
function buildReportSummary(moderationDetails) {
  if (!moderationDetails?.reports || moderationDetails.reports.length === 0) return '';
  const tags = [];
  const notes = [];
  moderationDetails.reports.forEach((report) => {
    if (report.type === 'individual_report' && report.reportType) {
      if (!tags.includes(report.reportType)) tags.push(report.reportType);
      const note = (report.additionalNote || '').trim();
      if (note && !notes.includes(note)) notes.push(note);
    } else if (report.type === 'row' && report.reason) {
      if (!tags.includes(report.reason)) tags.push(report.reason);
    }
  });
  if (tags.length === 0 && notes.length === 0) return '';
  return `\n\nALLEGED VIOLATION (what reporters flagged — may be incorrect, evaluate independently):\n`
    + tags.map(t => `- "${t}"`).join('\n')
    + (notes.length > 0 ? `${tags.length ? '\n' : ''}Reporter's stated reason:\n${notes.map(n => `- "${n}"`).join('\n')}` : '')
    + '\n';
}

async function analyzeWithLLM(originalPost, flaggedContent, conversationThread = [], additionalContext = '', imageUrls = []) {
  if (!CONFIG.apiKey || !CONFIG.apiEndpoint) {
    throw new Error('API configuration not set. Please configure in the extension side panel.');
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
  const reportSummary = buildReportSummary(moderationDetails);

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
(The full community guidelines are provided in the system prompt.)

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

EVIDENCE TEST — apply this BEFORE rating any category "Valid" or "Borderline".
You must be able to produce BOTH of the following. If you cannot produce both, the category is "Doesn't Apply":
  (a) A verbatim quote of the guideline clause that prohibits it — the guidelines' actual words, not a paraphrase, not a category name, not a rule you believe exists.
  (b) A verbatim quote of the flagged content that satisfies that clause AS WRITTEN.
An inference about what the content "edges toward", "reads as", "could be seen as", "risks", "borders on", or "may suggest" is NOT evidence, and never supports Valid or Borderline. If your reasoning needs one of those phrases, the honest rating is "Doesn't Apply".
A bullet under a guideline's NOT ALLOWED list is governed by the definition at the top of that guideline — a bullet never reaches content that definition never covered. Read the definition before citing a bullet under it.
Content is not a violation merely because no guideline explicitly permits it. ALLOWED lists are examples, not a whitelist; if no clause prohibits the content, it is allowed.

Step 1 - SCAN AGAINST EACH GUIDELINE CATEGORY:
For each category below, assess whether the flagged content violates it:
• "Valid" = Content clearly violates this guideline — clause and content quotes both available
• "Doesn't Apply" = No violation, INCLUDING every case where the evidence test fails
• "Borderline" = A FACT you cannot determine from the content itself decides it — e.g. you cannot tell whether the author owns the business they recommended, or whether an image shows what the text claims. It is NOT for a clause you are unsure applies, and NOT for content that merely feels uncomfortable. If the clause does not cover the content as written, that is "Doesn't Apply", not Borderline.

Categories to check:
- Respectfulness: personal attacks, public shaming of a private individual, threats, OR overall tone that mocks/belittles/demeans a specific neighbor — evaluate the full message in context, not individual words; mark Borderline if tone is ambiguous, Valid only if mocking intent is clear
- Discrimination: racism, sexism, homophobia, or other bias against a protected group
- Harmful activity: dangerous information, sharing someone's private address/personal details, fraud, spam
- Self-promotion: promoting the author's OWN business, service, or commercial offer from a personal account — in a post, in a comment (INCLUDING a reply to a neighbor asking for a recommendation — being asked does not make it allowed), or in a DM. Recommending someone else's business is allowed. Before marking Valid, apply the casual-service-provider test in Guideline 6: an occasional, under-their-own-name, small-scale neighbor offer (babysitting, lawn mowing, baked goods) is permitted. Mark Borderline when you cannot tell from the content whether the author is a business or a casual neighbor.
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
[One row per category. Keep reasoning to 1 short sentence. Omit categories that clearly don't apply. For any row NOT rated "Doesn't Apply", the Reasoning cell must contain the verbatim guideline clause in quotation marks — if you cannot quote one, the row is "Doesn't Apply".]

**Vote Suggestion:** [Keep | Remove | Maybe Remove]

**Reasoning:** [2-3 sentences explaining the vote. Cite the specific guideline NAME — NEVER use internal numbering. Must match your scan. For anything other than Keep, quote the guideline clause and the content that satisfies it; state nothing as a basis that you inferred rather than read.]

**Comment Suggestion:** [1 short sentence a moderator writes to OTHER moderators explaining their vote — NOT a message to the poster. Factual. E.g. "No violation — civil local opinion." or "Reseller commercial activity, not a personal sale."]
${hasAdditionalContext ? '\n**Moderator Notes:** [Brief response to moderator context]' : ''}

IMPORTANT: Be brief. Your vote MUST match your guideline scan.`;

  // Resized (and memoised) to reduce token cost — see buildImageBlocks.
  const imageBlocks = await buildImageBlocks(imageUrls);

  // Build user message content — array (with images) or plain string
  const userContent = imageBlocks.length > 0
    ? [...imageBlocks, { type: 'text', text: prompt }]
    : prompt;

  // Build request body
  const requestBody = {
    model: CONFIG.model,
    messages: [
      {
        role: 'system',
        // The guidelines live here rather than in the user prompt so they sit in
        // the cacheable prefix (render order is system -> messages) and stay
        // byte-identical across every analysis. In the user prompt they trailed
        // the per-post images and text, so nothing could cache them and the full
        // ~4K tokens were re-sent at full price on every single analysis. This
        // also matches callLLMQuestion/callLLMChat, which already do it this way.
        content: `You are an expert content moderation assistant for Nextdoor communities. Provide concise, well-formatted recommendations following the exact structure requested. Consider report tags, voting trends, reviewer comments, tone, and guideline violations. Be brief but thorough.

${NEXTDOOR_GUIDELINES}`,
      },
      {
        role: 'user',
        content: userContent,
      },
    ],
    ...(MODELS_SUPPORTING_TEMPERATURE.has(CONFIG.model) ? { temperature: 0 } : {}),
    // OpenAI-only fields; the Anthropic branch below rebuilds its own body and
    // ignores these. Previously uncapped — on a reasoning model with 128K max
    // output that is an unbounded cost risk, not just a slow response.
    ...openAiMaxTokens(ANALYSIS_MAX_TOKENS),
    ...openAiEffort(),
  };

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
    // Converts OpenAI-style image_url blocks to Anthropic-style image source blocks
    const userMessages = toAnthropicMessages(requestBody.messages.filter(m => m.role !== 'system'));
    body = JSON.stringify({
      model: requestBody.model,
      max_tokens: ANALYSIS_MAX_TOKENS,
      ...anthropicEffort(),
      system: [{ type: 'text', text: systemMsg?.content || '', cache_control: { type: 'ephemeral' } }],
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

  return parsedResponse;
}

/**
 * Parse LLM response into structured format
 */
function parseAnalysisResponse(apiResponse) {
  // Adapt this based on your LLM provider's response format
  const content = extractLLMText(apiResponse);

  // For simple one-sentence analysis, just return the text
  return {
    analysisText: content.trim(),
    rawResponse: content,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Handle messages from content script or side panel
 */
browser.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  console.log('[Background] Received message:', message.action);

  // Restore per-tab caches if the SW was restarted since the last message.
  await ensureHydrated();

  if (message.action === 'analyzeContent') {
    try {
      // The startup loadConfig() at the bottom of this file is not awaited, so on a
      // cold service-worker start CONFIG can still be empty when this message
      // arrives — which surfaced as a spurious "API configuration not set".
      await loadConfig();

      const { originalPost, flaggedContent, conversationThread, additionalContext, imageUrls } = message.data;

      // Perform analysis with full conversation context, additional context, and images
      const analysis = await analyzeWithLLM(originalPost, flaggedContent, conversationThread, additionalContext, imageUrls || []);

      // The side panel is the only caller and awaits this response directly, so
      // there is no separate analysisResult push-back message any more.
      sendResponse({ success: true, analysis: analysis });
    } catch (error) {
      console.error('[Background] Analysis error:', error);

      sendResponse({ success: false, error: error.message });
    }
    return true; // Keep channel open for async response
  }

  if (message.action === 'chatAboutPost') {
    await loadConfig();
    if (!CONFIG.apiKey || !CONFIG.apiEndpoint) return { success: false, answer: 'No API configured.' };
    try {
      const { text, inputTokens, outputTokens, cachedTokens } = await callLLMChat(message.question, message.markdown, message.history || [], message.imageUrls || [], message.moderationDetails || null);
      return { success: true, answer: text, inputTokens, outputTokens, cachedTokens };
    } catch (error) {
      return { success: false, answer: 'Error: ' + error.message };
    }
  }

  if (message.action === 'askAboutPost') {
    await loadConfig();
    if (!CONFIG.apiKey || !CONFIG.apiEndpoint) return { success: false, answer: 'No API configured.' };
    try {
      const answer = await callLLMQuestion(message.question, message.reviewData, message.analysisText, message.history || [], message.imageUrls || []);
      return { success: true, answer };
    } catch (error) {
      return { success: false, answer: 'Error: ' + error.message };
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

  // sender.tab is only populated for content-script-originated messages — the side
  // panel isn't a tab, so it passes its target tabId explicitly instead.
  if (message.action === 'getLastExpandedPost') {
    const tabId = message.tabId ?? sender.tab?.id;
    const postId = lastExpandedPostId.get(tabId);
    const cache = postDataCache.get(tabId);
    const entry = postId ? cache?.get(postId) : null;
    return { success: !!entry, post: entry?.post || null };
  }

  if (message.action === 'getPostById') {
    const tabId = message.tabId ?? sender.tab?.id;
    const cache = postDataCache.get(tabId);
    let entry = null;
    if (cache && message.postId != null) {
      const id = String(message.postId);
      entry = cache.get(id)
        || cache.get(id.replace(/^post_/, ''))  // stored numeric?
        || cache.get('post_' + id);              // stored prefixed?
    }
    // moderationSummaryV3 is only present when this post's id was ALSO seen in a
    // captured /ModerationFeed response (cachePostsFromResponse walks every feed
    // operation into the same postDataCache) — most Post Panel opens are on posts
    // that were never reported, so this is null far more often than not, by design.
    // It used to live only on post.moderationInfo; every concrete FeedItem type
    // now also implements ModeratableFeedItem (`moderationInfo:
    // ContentModerationInfo!`), so fall back to the feed item. A feed-item
    // summary on a comment report describes the comment, so skip it there.
    const fi = entry?.feedItem;
    const moderationSummary = entry?.post?.moderationInfo?.moderationSummaryV3
      || (fi && !fi.comment ? fi.moderationInfo?.moderationSummaryV3 : null)
      || null;
    return {
      success: !!entry,
      post: entry?.post || null,
      moderationSummary,
    };
  }

  if (message.action === 'getModerationFeedData') {
    const tabId = message.tabId ?? sender.tab?.id;
    return { data: capturedApiData.get(tabId) || null };
  }

  if (message.action === 'clearExpandedPost') {
    // The expanded-post modal closed — forget which post was open so a later
    // open can't serve this stale one.
    const tabId = message.tabId ?? sender.tab?.id;
    lastExpandedPostId.delete(tabId);
    persistTab(tabId);
    // Broadcast so an open side panel clears its display too — otherwise it
    // keeps showing the just-closed post with nothing telling it to stop.
    browser.runtime.sendMessage({ action: 'expandedPostCleared', tabId }).catch(() => {});
    return;
  }

  // Relay to the content script — these two need to read/act on the live page
  // (Nextdoor's rendered DOM), which only the content script can do. The side
  // panel supplies tabId explicitly since it has no sender.tab of its own.
  if (message.action === 'runExpandAllReplies' || message.action === 'getExpandedPostId') {
    const tabId = message.tabId ?? sender.tab?.id;
    if (tabId == null) return { error: 'No target tab' };
    return browser.tabs.sendMessage(tabId, { action: message.action });
  }

  // Also a content-script relay, but unlike the two above it can't just forward
  // the response — captureVisibleTab() is a background-only API (no chrome.tabs
  // in a content script), so this orchestrates: ask the page for a selected
  // region, then screenshot the tab and crop to it.
  if (message.action === 'startRegionCapture') {
    const tabId = message.tabId ?? sender.tab?.id;
    if (tabId == null) return { success: false, error: 'No target tab' };
    try {
      const selection = await browser.tabs.sendMessage(tabId, { action: 'startRegionCapture' });
      if (!selection || selection.cancelled || !selection.rect) return { success: false, cancelled: true };
      const tab = await browser.tabs.get(tabId);
      const shot = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      const dataUrl = await cropDataUrl(shot, selection.rect);
      if (!dataUrl) return { success: false, error: 'Capture failed' };
      return { success: true, dataUrl };
    } catch (err) {
      console.error('[BG] startRegionCapture failed:', err.message);
      return { success: false, error: err.message };
    }
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

  // ---- GraphQL traffic captured by the page-context net-hook ----
  // Replaces the Firefox-only webRequest.filterResponseData() interceptor.
  // The MAIN-world net-hook posts response bodies to the isolated content
  // script, which forwards them here so the same caching/notification logic runs.
  if (message.action === 'gqlRequestStarted') {
    const tabId = sender.tab?.id;
    if (tabId == null || typeof message.url !== 'string') return;

    if (message.url.includes('/ModerationFeed')) {
      lastExpandedPostId.delete(tabId);
      // Drop the previous item's payload the moment a new one is requested —
      // otherwise getModerationFeedData serves the OLD reported item during the
      // in-flight window, and the side panel renders the wrong post. This mirrors
      // content-api.js, which nulls its own `moderationFeedData` on this signal.
      capturedApiData.delete(tabId);
      // The side panel's Review tab is the only listener — it has no
      // content-script presence, so this goes out on runtime.sendMessage.
      browser.runtime.sendMessage({ action: 'moderationFeedLoading', tabId }).catch(() => {});
    }

    if (message.url.includes('/ExpandedFeedItemStory')) {
      // A new post is being expanded — drop the stale "which post is expanded"
      // pointer so the Post Panel can't serve the previous post. The matching
      // gqlResponseCaptured (ExpandedFeedItemStory) repopulates it with the real one.
      lastExpandedPostId.delete(tabId);
      // Broadcast to any open side panel — opening a post is a same-tab SPA state
      // change with no URL change, so tabs.onActivated/onUpdated never fire for
      // it; this is the only signal the side panel gets that a post just opened.
      // (Only the side panel needs this — content-api.js no longer builds any
      // UI off expandedPostReady/expandedPostCleared, so it isn't sent there.)
      browser.runtime.sendMessage({ action: 'expandedPostCleared', tabId }).catch(() => {});
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
          browser.runtime.sendMessage({
            action: 'expandedPostReady',
            post: feedItem.post,
            legacyAnalyticsId: feedItem.legacyAnalyticsId,
            tabId,
          }).catch(() => {});
        }
      }

      if (url.includes('/PagedComments')) {
        mergePagedComments(tabId, data);
      }

      if (url.includes('/ModerationFeed')) {
        capturedApiData.set(tabId, data);
        browser.runtime.sendMessage({ action: 'moderationDataReady', tabId }).catch(() => {});
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

  // Only notify the side panel if this is still the active expanded post
  if (lastExpandedPostId.get(tabId) === postId) {
    browser.runtime.sendMessage({
      action: 'expandedPostReady',
      post: entry.post,
      legacyAnalyticsId: entry.feedItem?.legacyAnalyticsId,
      tabId,
    }).catch(() => {});
  }
}

// GraphQL response capture is handled in the runtime.onMessage listener above
// (actions 'gqlRequestStarted' / 'gqlResponseCaptured'), fed by the page-context
// net-hook. MV3 has no webRequest.filterResponseData() equivalent.
console.log('[Background] GraphQL capture wired via net-hook message bridge');

// Load configuration on startup
loadConfig();
