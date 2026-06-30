# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Chrome browser extension (Manifest V3) for Nextdoor community moderators. It captures Nextdoor's moderation GraphQL API responses, extracts moderation metadata, and sends flagged content to an LLM (OpenAI/Anthropic, user's own key) for independent analysis and vote recommendations.

This is a port of the Firefox (Manifest V2) version. The behaviour and message contracts are preserved; the network-capture mechanism was rearchitected for MV3 (see below).

**Technology Stack:**
- **Platform:** Chrome Extension, Manifest V3
- **Build Tool:** Vite 7.2+ with `vite-plugin-web-extension` (`browser: 'chrome'`)
- **Language:** Vanilla JavaScript (ES modules)
- **UI:** Plain HTML/CSS (no framework)
- **Compat shim:** `webextension-polyfill` (lets the code keep using promise-based `browser.*`)
- **Package Manager:** npm

## Development Commands

```bash
npm install      # Install dependencies
npm run dev      # Watch mode with auto-rebuild
npm run build    # Production build → dist/
```

## Loading the Extension in Chrome

1. `npm run build`
2. Go to `chrome://extensions`
3. Enable **Developer mode** (top-right)
4. Click **Load unpacked** and select the `dist/` folder
5. After each rebuild, click **Reload** (↻) on the extension card

## Architecture

### Network capture (the MV3-specific part)

Firefox read GraphQL response bodies with `webRequest.filterResponseData()`. Chrome MV3 has no equivalent, so capture is done in three hops:

1. **`src/inject/net-hook.js`** — a `"world": "MAIN"`, `run_at: "document_start"` content script. It monkey-patches `window.fetch` and `XMLHttpRequest` in the page's own JS context. For any `/api/gql/` URL it `window.postMessage`s `{ source: 'ndm-net-hook', phase, url, body }` to the page.
2. **`src/content/content-api.js`** (isolated world) — a small bridge at the top of the file listens for those messages and forwards them to the service worker via `chrome.runtime.sendMessage` (`gqlRequestStarted` / `gqlResponseCaptured`).
3. **`src/background/background.js`** (service worker) — handles those two actions, running the same caching/notification logic the Firefox `webRequest` interceptor used (`cachePostsFromResponse`, `mergePagedComments`, `lastExpandedPostId`), and sends `moderationFeedLoading` / `moderationDataReady` / `expandedPostReady` back to the tab.

The preserved message contract between SW and content scripts:
`moderationFeedLoading`, `moderationDataReady` `{ data }`, `expandedPostReady` `{ post, legacyAnalyticsId }`, plus content→SW `getLastExpandedPost`, `analyzeContent`, `chatAboutPost`, `askAboutPost`, `sharpResponses`, `generateCommentVariations`, `getConfig`, `saveConfig`, `getGuidelines`.

### Components

1. **Service worker** (`src/background/background.js`)
   - GraphQL data caching (keyed by tabId; rebuilt from live traffic, not persisted — the SW is non-persistent)
   - LLM calls (OpenAI/Anthropic) — the embedded `NEXTDOOR_GUIDELINES` constant is the system context
   - Image resize uses `createImageBitmap` + `OffscreenCanvas` (no DOM in a worker)
   - Config in `chrome.storage.local`

2. **Content script** (`src/content/content-api.js`)
   - net-hook bridge, overlays, AI Review / Post Panel UI, auto-vote
   - `content.js` is NOT registered in the manifest (legacy DOM-scanner kept for parity)

3. **Popup** (`src/popup/`) — provider/key/model config, validated on save

4. **Guidelines page** (`src/guidelines/`) — renders the guidelines sent to the LLM (uses `chrome.runtime.sendMessage`; it is copied verbatim, not bundled, so it can't import the polyfill)

### `browser.*` vs `chrome.*`

Bundled entry points (`background.js`, `content-api.js`, `content.js`, `popup.js`) import `webextension-polyfill` and keep using `browser.*`. `guidelines.js` is copied verbatim (not bundled) and uses `chrome.*` directly.

## Permissions

`permissions: ["storage"]` only. Hosts are in `host_permissions` (`nextdoor.com`, `anthropic.com`, `openai.com`). No `activeTab`, `webRequest`, `webRequestBlocking`, `tabs`, or `debugger`.

## Store-compliance notes

- No remote code; everything is bundled locally
- Restrictive `extension_pages` CSP (`script-src 'self'; object-src 'self'`)
- Minimal, justified permissions; single-purpose
- Code is unobfuscated and readable
