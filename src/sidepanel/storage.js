/**
 * Per-post persistence for the side panel tabs, lifted out of review.js so the
 * Post Panel can reuse it rather than growing a second copy.
 *
 * Both tabs store one record per post id in chrome.storage.local with a TTL:
 * moderation work is per-post and short-lived, and without expiry the store would
 * grow without bound across every post a moderator ever opened. Each caller gets
 * its own key prefix so Review and Post Panel records never collide, and so a
 * purge sweeps only its own namespace.
 */
import browser from 'webextension-polyfill';

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function createPostStore(prefix, ttlMs = DEFAULT_TTL_MS) {
  const keyFor = postId => `${prefix}${postId}`;

  async function save(postId, data) {
    if (!postId) return;
    const now = Date.now();
    // The record is REPLACED, not merged — callers must pass every field they
    // want kept. (A partial save here is what silently dropped the Review tab's
    // analysisText once already.)
    await browser.storage.local.set({
      [keyFor(postId)]: { ...data, savedAt: now, expiresAt: now + ttlMs },
    });
  }

  async function load(postId) {
    if (!postId) return null;
    const key = keyFor(postId);
    const result = await browser.storage.local.get(key);
    const record = result[key];
    if (!record) return null;
    if (Date.now() > record.expiresAt) {
      await browser.storage.local.remove(key);
      return null;
    }
    return record;
  }

  async function clear(postId) {
    if (!postId) return;
    await browser.storage.local.remove(keyFor(postId));
  }

  // Reading every record on startup is the cost of not tracking an index; the
  // store holds at most a few dozen small JSON blobs, so it stays cheap.
  async function purgeExpired() {
    const all = await browser.storage.local.get(null);
    const expired = Object.keys(all).filter(k =>
      k.startsWith(prefix) && all[k]?.expiresAt && Date.now() > all[k].expiresAt
    );
    if (expired.length > 0) await browser.storage.local.remove(expired);
  }

  return { save, load, clear, purgeExpired };
}
