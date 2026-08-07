# Nextdoor Moderator Assistant (Chrome)

A Chrome extension (Manifest V3) that helps Nextdoor community moderators make faster, more consistent decisions using AI analysis.

The extension intercepts Nextdoor's moderation GraphQL API in real time, extracts post and voting data, and sends it to an LLM for independent analysis — without leaving the page.

> Ported from the Firefox (Manifest V2) version. Because Chrome MV3 has no equivalent of Firefox's `webRequest.filterResponseData()`, response capture is done with a page-context `fetch`/`XHR` hook instead. See [How It Works](#how-it-works).

---

## Features

The extension lives entirely in a Chrome **side panel** (opened via the toolbar icon) with three tabs — it injects nothing into the Nextdoor page itself.

- **Review tab** — On the moderation queue, auto-loads the currently-open flagged post's report data and produces a Keep / Maybe Remove / Remove recommendation with guideline-based reasoning
- **Post Panel tab** — On any open post: full thread preview, AI chat, a "Scan for violations" pass, and comment drafting
- **AI Chat** — Ask follow-up questions about a post in context; the full thread is always in scope
- **Poll Support** — Correctly handles survey/poll posts in addition to standard text posts
- **Settings tab** — Configure provider/API key/model without leaving the panel
- **Per-Provider API Keys** — OpenAI and Anthropic keys stored separately; switching providers restores the correct key automatically
- **Model Badge** — The panel header always shows which provider and model is active
- **Privacy-First** — API keys stored locally in `chrome.storage.local`, never transmitted to third parties
- **Copy, don't auto-vote** — The extension only copies a suggested comment to your clipboard; you cast every vote yourself on Nextdoor

---

## Installation

### From the Chrome Web Store

*(Coming soon)*

### Manual / Development (Load Unpacked)

1. Clone the repo and install dependencies:
   ```bash
   git clone https://github.com/DrBenedictPorkins/nextdoor-moderator-extension.git
   cd nextdoor-moderator-extension
   npm install
   ```

2. Build:
   ```bash
   npm run build
   ```

3. Load in Chrome:
   - Navigate to `chrome://extensions`
   - Toggle **Developer mode** (top-right)
   - Click **Load unpacked**
   - Select the generated `dist/` folder

4. Configure:
   - Click the extension icon in the toolbar to open the side panel
   - Switch to the **Settings** tab
   - Select your LLM provider (OpenAI or Anthropic)
   - Paste your API key and choose a model
   - Click **Save Configuration** — the key is validated before saving

> After rebuilding, click the **Reload** (↻) button on the extension card in `chrome://extensions`.

---

## Usage

Open the side panel from the toolbar icon. It tracks whichever Nextdoor tab is active and switches tabs automatically as you navigate.

### Moderation Queue — Review tab

1. Go to `https://nextdoor.com/moderation_feed`
2. Click a flagged post — the panel switches to the **Review** tab and auto-loads the report data as soon as it captures the API response
3. Click **Analyze with AI** to get a color-coded recommendation (green = Keep, red = Remove, amber = Maybe Remove) with tag analysis and reasoning
4. Click **Copy Comment** to copy the suggested moderator note, then cast your vote and paste the note directly on Nextdoor — the extension never submits a vote itself

### Any Post — Post Panel tab

Off the moderation queue, the panel shows the **Post Panel** tab for whatever post is open:

- **Preview here** — expands all replies and loads the full thread
- **Scan for violations** — an AI pass over the whole thread against the guidelines
- AI Chat — ask questions about the post; the full thread is always included
- Mod History shortcut in the header

### Additional Context

Before clicking "Analyze with AI", use the **Additional Context** field to describe anything the LLM can't see — images, videos, links. The LLM uses this as factual input only; moderator opinions in that field do not influence the vote.

---

## Configuration

| Setting | Description |
|---------|-------------|
| API Provider | OpenAI or Anthropic |
| API Key | Stored per-provider in `chrome.storage.local` |
| Model | Provider-specific model list; validated on save |

Keys are validated against the live API before saving. Switching providers restores the previously saved key for that provider.

### Supported Models

**OpenAI:** GPT-5.6 (Sol / Terra / Luna), GPT-4o, GPT-4o mini, o3, o4-mini

**Anthropic:** Claude Opus 5, Claude Sonnet 5, Claude Sonnet 4.6, Claude Haiku 4.5

---

## How It Works

```
1. A MAIN-world content script (net-hook) patches window.fetch / XHR at document_start
2. When Nextdoor calls its ModerationFeed GraphQL API, the hook clones the
   response text and window.postMessages it to the isolated content script
3. The content script forwards the body to the background service worker
4. The service worker parses moderationSummaryV3: post content, reports, votes, thread,
   and broadcasts moderationDataReady to the side panel
5. The side panel's Review tab auto-loads the post metadata
6. User optionally adds context → clicks Analyze with AI
7. The side panel asks the service worker to send a structured prompt to the LLM
8. LLM response parsed and displayed inline with vote card + reasoning
```

**Why a page-context hook?** Firefox reads GraphQL response bodies with
`webRequest.filterResponseData()`. Chrome MV3 removed blocking `webRequest` and
never had `filterResponseData`, so the only reliable way to read response bodies
is to wrap `fetch`/`XHR` in the page's own JS context (`"world": "MAIN"`) and
post the data back to the extension.

---

## Permissions

| Permission | Reason |
|------------|--------|
| `storage` | Store API configuration locally |
| `sidePanel` | Gates the side panel UI surface |
| `activeTab` | Required by `chrome.tabs.captureVisibleTab()` for the Review tab's screenshot capture |
| `host_permissions: *://*.nextdoor.com/*` | Run on Nextdoor pages and read moderation data |
| `host_permissions: *://*.anthropic.com/*` | Anthropic API calls |
| `host_permissions: *://*.openai.com/*` | OpenAI API calls |

No `webRequest`, `webRequestBlocking`, or `tabs` permission is requested.

---

## Development

```bash
npm run dev      # Watch mode with auto-rebuild
npm run build    # Production build → dist/
```

After rebuilding, click **Reload** on the extension card in `chrome://extensions`.

---

## Privacy

See [PRIVACY.md](PRIVACY.md) for the full privacy policy.

---

## Disclaimer

This extension is not affiliated with or endorsed by Nextdoor. It is an independent tool to assist community moderators. All moderation decisions rest with the human moderator.

---

## License

[MIT](LICENSE)
