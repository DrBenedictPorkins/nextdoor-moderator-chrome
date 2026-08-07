# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/).

## [1.2.0] - Unreleased

### Changed
- **All UI moved into a Chrome side panel.** The floating in-page widget, the AI Review overlay, the vote footer, and the fixed-position Post Panel drawer are gone — everything now lives in a single side panel (toolbar icon) with three tabs: Review, Post Panel, and Settings. This removes the visual overlap the old Post Panel drawer had with Nextdoor's own post modal. The side panel tracks whichever Nextdoor tab is active and switches between the Review and Post Panel tabs automatically as you navigate between the moderation queue and individual posts.
- Chat prompts now require grounded claims and concede unsupported pushback

### Added
- Self-promotion policy guideline (GUIDELINE 6) and a dedicated scan category in the AI analysis prompt
- Extraction and logging of GraphQL fields for future self-promo detection: `postType`, `classified`, `classifiedInfo`, `localServiceData`, `authorType` (posts), `detectedBusiness`, `authorType` (comments)
- New model options: Claude Opus 5, Claude Sonnet 5, GPT-5.6 (Sol/Terra/Luna) — older models (Sonnet 4.6, Haiku 4.5, GPT-4o, o3, o4-mini) kept alongside them
- Post Panel "Scan for violations" — reports only violations and borderline calls, with an opening line stating coverage
- `scripts/download-nextdoor-video.sh` — downloads a post's HLS video from its signed CloudFront manifest

### Fixed
- Intermittent "API configuration not set" error on first "Analyze with AI" click after service worker start
- `temperature` param sent to models that reject it outright (400 error) — now gated per model
- "Apply to vote" losing its comment when switching to a different vote pill and back
- "Copy All" fabricating vote-count data and omitting real reporter/reviewer names, report reasons, and notes
- "Copy All" output rendering as one run-on paragraph wherever pasted (markdown soft-break issue)
- `cut-hotfix-finish.sh` blanket-overwriting version files on merge conflict, which could silently discard other legitimate hotfix changes
- `expandAllReplies` firing globally on every opened post instead of only during moderation review, and its button-finding queries being unscoped to the open post's overlay (risked clicking into the wrong post)

## [1.1.1] - 2026-07-02

- Chat answers the moderator's actual question instead of gating on-topic replies against the guidelines

## [1.1.0] - 2026-07-02

- Copy/paste voting, recommendation chip, and UI cleanup
- Post Panel: resolve the open post by DOM fiber id and persist cache across service worker restarts
- Updated AI recommendation screenshot to the Copy Comment UI

## [1.0.0] - 2026-06-29

- Initial release: Nextdoor Moderator Assistant for Chrome (Manifest V3)
