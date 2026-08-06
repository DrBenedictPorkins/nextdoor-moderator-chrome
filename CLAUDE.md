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

## Branching

`main` is the dev branch — there is no separate `develop`/`dev` branch, locally or on `origin`. All day-to-day work happens directly on `main`. `scripts/cut-release.sh` and `scripts/cut-hotfix-start.sh`/`cut-hotfix-finish.sh` create short-lived branches off `main` for version bumps, merged back into `main` when done.

## Architecture

### Network capture (the MV3-specific part)

Firefox read GraphQL response bodies with `webRequest.filterResponseData()`. Chrome MV3 has no equivalent, so capture is done in three hops:

1. **`src/inject/net-hook.js`** — a `"world": "MAIN"`, `run_at: "document_start"` content script. It monkey-patches `window.fetch` and `XMLHttpRequest` in the page's own JS context. For any `/api/gql/` URL it `window.postMessage`s `{ source: 'ndm-net-hook', phase, url, body }` to the page.
2. **`src/content/content-api.js`** (isolated world) — a small bridge at the top of the file listens for those messages and forwards them to the service worker via `chrome.runtime.sendMessage` (`gqlRequestStarted` / `gqlResponseCaptured`).
3. **`src/background/background.js`** (service worker) — handles those two actions, running the same caching/notification logic the Firefox `webRequest` interceptor used (`cachePostsFromResponse`, `mergePagedComments`, `lastExpandedPostId`), and broadcasts `moderationFeedLoading` / `moderationDataReady` / `expandedPostReady` / `expandedPostCleared`.

**Message contract (current).** The side panel, not the content script, is now the SW's client, so the notifications go out on `runtime.sendMessage` with an explicit `tabId` (the panel has no `sender.tab` of its own and filters on that field):

- **SW → side panel (broadcast):** `moderationFeedLoading`, `moderationDataReady`, `expandedPostReady` `{ post, legacyAnalyticsId }`, `expandedPostCleared`
- **SW → content script (`tabs.sendMessage`):** `runExpandAllReplies`, `getExpandedPostId` — the only two operations needing the live page
- **→ SW:** `gqlRequestStarted`, `gqlResponseCaptured`, `clearExpandedPost`, `getModerationFeedData`, `getPostById`, `getLastExpandedPost`, `analyzeContent`, `chatAboutPost`, `askAboutPost`, `generateCommentVariations`, `saveConfig`, `getGuidelines`

Actions that existed and are **gone**: `scanPage`, `analysisResult`, `analysisError` (the side panel awaits `analyzeContent`'s response directly), `getConfig` (never called, and it returned the API key), `sharpResponses`.

### Components

1. **Service worker** (`src/background/background.js`)
   - GraphQL data caching (keyed by tabId; rebuilt from live traffic, not persisted — the SW is non-persistent)
   - LLM calls (OpenAI/Anthropic) — the embedded `NEXTDOOR_GUIDELINES` constant is the system context
   - Image resize uses `createImageBitmap` + `OffscreenCanvas` (no DOM in a worker)
   - Config in `chrome.storage.local`

2. **Content script** (`src/content/content-api.js`) — **217 lines; builds no UI at all.** Three jobs only: the net-hook bridge, `runExpandAllReplies` (clicks Nextdoor's own "see N more replies" controls), and `getExpandedPostId` + the expanded-post close watcher. The floating "ND Moderator" widget and the ~1,800 lines of in-page overlay it drove are **deleted** (see `## Dead code removed`). `content.js` is NOT registered in the manifest — legacy DOM-scanner, never built, never shipped.

3. **Side panel** (`src/sidepanel/`) — opens via the toolbar icon (`chrome.sidePanel`, not a popup); replaces the deleted `src/popup/`. All three tabs are live:
   - `review.js` — the moderation queue workflow: auto-loads the reported item on `moderationDataReady`, Analyze with AI, Q&A chat, vote footer. **No refresh button by design** — Next/Previous each issue a real `/ModerationFeed` request, so the capture is always current.
   - `postpanel.js` — any open post: Preview here (expands replies), "Scan for violations", chat. ↻ re-runs the fetch and **clears the chat after warning**.
   - `settings.js` — provider/key/model, validated against the live API before saving. Owns `PROVIDER_MODELS`; exports `getModelLabel()` / `PROVIDER_LABELS` for the header badge.
   - `storage.js` — `createPostStore(prefix, ttl)`, per-post records in `storage.local` with a 7-day TTL. Two namespaces: `nd_review_` (analysis HTML + text + Q&A log + additional context) and `nd_chat_` (Post Panel conversation + comment count + token totals). **Records are replaced wholesale, not merged** — a partial save silently drops fields, which has already caused one bug.
   - `sidepanel.js` — tab switching, the off-Nextdoor gate, auto-switch Review↔Post Panel on entering/leaving `/moderation_feed/`, the header **model badge** (live via `storage.onChanged`), and Mod History.

4. **Guidelines page** (`src/guidelines/`) — renders the guidelines sent to the LLM (uses `chrome.runtime.sendMessage`; it is copied verbatim, not bundled, so it can't import the polyfill)

### `browser.*` vs `chrome.*`

Bundled entry points (`background.js`, `content-api.js`, `sidepanel.js`) import `webextension-polyfill` and keep using `browser.*`. `net-hook.js` runs in the MAIN world with no polyfill and no extension APIs at all — plain `window`/`fetch`/`postMessage`. `guidelines.js` is copied verbatim (not bundled) and uses `chrome.*` directly. `background.js` calls `chrome.sidePanel.setPanelBehavior(...)` directly (Chrome-specific API, not wrapped by the polyfill).

## The guidelines text is source data — never edit it

`NEXTDOOR_GUIDELINES` in `src/background/background.js` is scraped from Nextdoor's own help articles (each section carries its `Source:` URL). It is **source data, not prose to be improved**. Do not reword, clarify, tighten, disambiguate, add carve-outs to, or "make self-contained" any part of it, and do not add rules that Nextdoor has not published. The extension's whole value is that its analysis rests on what Nextdoor actually says; a paraphrase is an interpretation, and a moderator acting on it is acting on our opinion while believing it is policy.

It follows that when the LLM misapplies a guideline, **the fix belongs in the prompt, not the guidelines**. Prompts may instruct the model on how to *read* the text — e.g. that bullets under a `NOT ALLOWED` list are governed by the definition at the top of that guideline, or that absence from an `ALLOWED` list is not a prohibition. That is reading guidance. Rewriting the bullet so it needs no such guidance is editing policy.

If the scraped text genuinely appears wrong or out of date, say so and point at the `Source:` URL — re-scraping it is the user's call, not a silent edit.

The same constant feeds every LLM path and the Guidelines page (`getGuidelines`), so any change to it changes every analysis at once.

## Permissions

`permissions: ["storage", "sidePanel"]`. Hosts are in `host_permissions` (`nextdoor.com`, `anthropic.com`, `openai.com`). No `activeTab`, `webRequest`, `webRequestBlocking`, `tabs`, or `debugger` — `sidePanel` only gates the side panel UI surface itself, not data access; tab targeting is done via `tabId`s the background service worker already receives for free (`sender.tab.id`) and `tabs.query()`/`tabs.sendMessage()`, neither of which needs the `tabs` permission when scoped to a host already covered by `host_permissions`.

## Side panel migration — COMPLETE

All page-injected UI now lives in the Chrome side panel, which is why the extension no longer overlaps Nextdoor's own layout (the old Post Panel drawer cut off the right edge of the post modal). Original plan: `/Users/makram/.claude/plans/cozy-baking-penguin.md`. Every phase is done, including the final in-page cleanup — the dormant in-page fallback the plan kept during the trial has been deleted.

## Dead code removed (2026-08-05)

Found by tracing reachability from real entry points and by diffing handled-vs-sent message actions. Plain zero-reference counting was useless: the dead cluster referenced itself, so only `createContentOverlay` looked unused.

- `content-api.js`: **2,877 → 217 lines** (bundle 82.5 kB → 12.5 kB). Deleted the overlay UI (`createContentOverlay` … `styleVoteSuggestion`, vote footer/toast/chip, error + analysis overlays), its copy of `extractModerationData` and the formatters, and the review-storage helpers only it used.
- `net-hook.js`: the **auto-vote bridge** and its two hardcoded persisted-query hashes. Nothing posted `ndm-vote-req` — `#rv-submit-vote` is "Copy Comment". **The extension can no longer POST a vote to Nextdoor**, which matches what Settings promises the user. Recoverable from git if auto-vote is ever wanted back.
- `background.js`: the `analysisResult`/`analysisError` push-backs (guarded by `if (sender.tab)`, which is never set for a side-panel caller — dead since the Review port) and the `getConfig` handler (never called, and it returned `CONFIG` including the API key).

Verified clean afterwards: no unused CSS classes, all 8 `format.js` exports used, no unreferenced functions left anywhere.

## STATE OF WORK — read this first (2026-08-06)

Prepping for `cut-release.sh` and Chrome Web Store submission. Nothing is committed yet — `src/sidepanel/` is entirely untracked and `cut-release.sh` aborts on a dirty tree.

### Blocker: wrong reported reply is analyzed

`review.js` picks `flaggedComments[0]`. `findFlaggedCommentsRecursive` collects **every** comment carrying `moderationInfo.moderationSummaryV3`, so on a post with several reported replies — common — the panel analyzes whichever one sits first in tree order, not the one the moderator is being asked to vote on. Nothing signals the mismatch. `validation.postIsFlagged` has the same shape of bug directly above it: it wins unconditionally, so if the parent post is also reported, every reported reply renders the post instead.

Confirmed from logs, not inferred: Next/Previous *do* refetch, and each response carries `items: 1` — the repeated `post_500404913` was the same parent post with different reported replies, which is correct.

**To fix, we need the field on the feed item that names the reported comment.** Get it from the service-worker console: find a `[Background] Received message:` line with `action: 'gqlResponseCaptured'` and `url: '/api/gql/ModerationFeed?'`, expand it, and read the keys of `data.me.moderationFeed.feedItems[0]` — looking for a comment id, `reportedContent`, `moderationItem`, or a `moderationSummary` on the feed item rather than the post. Do not guess the field name.

### Prompt hardening already applied

Both the analysis and the scan now gate every finding on an **evidence test**: quote the prohibiting clause verbatim AND the content satisfying it as written, or rate it "Doesn't Apply". Inference language (*edges toward, reads as, could be seen as*) is explicitly not evidence. "Borderline" means a **fact** that can't be settled from the content, not a clause that might stretch. Both Q&A paths also got a symmetric concession rule — re-read the guideline before conceding, and hold the position (quoting the clause) when the text supports it, rather than caving to confident pushback.

`SCAN_PROMPT` (`postpanel.js`) reports **only** violations and borderline calls; clean items are assessed but not printed, with an opening line stating coverage.

### Remaining before submission

1. **Fix the flagged-reply bug** (above) — the only functional blocker.
2. **Logging** — 18 `console.log` in `review.js`, 11 in `background.js`; several dump full post bodies and LLM prompts. Put behind a debug flag. `content-api.js` is at zero.
3. **`docs/store-submission.md` is stale** — still sells a "floating quick-access widget" (deleted), calls Post Panel "an expandable side panel on any open post", says AI Review is "one-click" (it auto-loads), and claims "every recommendation shows which model produced it" — untrue per-recommendation; `background.js` returns the model but no UI renders it on the analysis card. Either display it or reword.
4. **`README.md`** — same staleness (widget, "Extension Popup", flow section).
5. **`assets/screenshots/`** — all five predate the side panel; `01-popup-configuration.jpeg` shows a popup that no longer exists. Reviewers compare screenshots to behavior.
6. **`CHANGELOG.md`** 1.2.0 — documents popup work, never mentions the side panel migration, the single biggest change in the release.
7. **`PRIVACY.md`** needs a public URL for the listing.
8. **Open question:** delete `src/content/content.js` (566 lines, unregistered, never shipped)?

Version is 1.2.0 in both `package.json` and `manifest.json`, unreleased. `dist/` is 204K / 13 files. Package with `(cd dist && zip -r ../nextdoor-moderator-chrome-1.2.0.zip .)` after `cut-release.sh`.

## Downloading a post's video (evidence review)

Nextdoor serves post videos as HLS: the `<video>` tag shows a `blob:` URL, backed by CloudFront-signed `.m3u8`/`.ts` files fetched via MediaSource Extensions — there's no plain downloadable file URL. `scripts/download-nextdoor-video.sh` handles this:

```bash
./scripts/download-nextdoor-video.sh "<signed main .m3u8 URL>" output.mp4
```

To get the signed main manifest URL, either watch the Network tab (filter: `m3u8`) while the video plays, or run in the page console:
```js
performance.getEntriesByType('resource').find(e => /main-.*\.m3u8/.test(e.name)).name
```

Why a plain `yt-dlp`/`curl` call on that URL 403s: the top-level manifest lists resolution variants (and each variant lists its `.ts` segments) as bare relative paths with no query string. The CloudFront signature (`Expires`/`Signature`/`Key-Pair-Id`/`Policy`) is a wildcard over the whole video directory (`Policy` `Resource` ends in `/*`), so the same signature from the URL you pass in is valid for every file under it — but resolving a relative path drops the query string, which 403s. The script re-attaches the signature to every sub-manifest/segment reference, picks the highest-bandwidth variant, then muxes with `ffmpeg`. Requires `ffmpeg` and `curl` on `PATH`. Signed URLs expire (see the `Expires` param, a Unix timestamp) — grab a fresh one if it's stale.

## Store-compliance notes

- No remote code; everything is bundled locally
- Restrictive `extension_pages` CSP (`script-src 'self'; object-src 'self'`)
- Minimal, justified permissions; single-purpose
- Code is unobfuscated and readable
- The extension never casts a vote — it only suggests, and the moderator votes on Nextdoor themselves. The auto-vote code path has been removed entirely, so this is now true of the code and not just the copy.
