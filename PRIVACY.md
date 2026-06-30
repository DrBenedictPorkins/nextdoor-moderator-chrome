# Privacy Policy — Nextdoor Moderator Assistant

*Last updated: June 2026*

## Summary

This extension does not collect, store, or transmit any personal data to the developer. The only data that leaves your browser is the moderation post content sent to the LLM API you configure.

---

## What data is processed

When you click **Analyze with AI**, the extension sends the following to your configured LLM provider (OpenAI or Anthropic):

- The text of the flagged post and its conversation thread
- Report tags and vote counts (no reviewer identity)
- Any additional context you type into the context field

This data is sent directly from your browser to the LLM API endpoint. It is not routed through any developer-owned server.

## What data is stored locally

The following is stored in Chrome's `chrome.storage.local` (on your device only):

- Your LLM API key(s)
- Your selected provider and model
- Cached analysis results for posts you have reviewed (stored by post ID, cleared when the extension is removed)

None of this data is accessible to the developer or any third party.

## What data is NOT collected

- No browsing history
- No Nextdoor account information or identity
- No analytics or usage telemetry
- No crash reports

## Third-party services

The extension communicates only with the LLM provider you configure:

- **OpenAI** — [Privacy Policy](https://openai.com/policies/privacy-policy)
- **Anthropic** — [Privacy Policy](https://www.anthropic.com/privacy)

Your use of these services is governed by their respective privacy policies. The extension developer has no relationship with, or access to, any data processed by these services.

## Nextdoor data

Post content processed by this extension originates from Nextdoor's moderation API. You are responsible for ensuring your use of this extension complies with Nextdoor's Terms of Service and any applicable data protection obligations in your jurisdiction.

## Changes

If this policy changes materially, the updated version will be committed to this repository with a revised date above.

## Contact

Open an issue at [github.com/DrBenedictPorkins/nextdoor-moderator-extension](https://github.com/DrBenedictPorkins/nextdoor-moderator-extension/issues).
