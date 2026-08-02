#!/usr/bin/env bash
# download-nextdoor-video.sh — Download a Nextdoor post video from its signed HLS manifest URL.
#
# Nextdoor serves post videos as HLS: the <video> tag shows a blob: URL, backed by
# CloudFront-signed .m3u8/.ts files. The top-level manifest lists sub-playlists (and each
# sub-playlist lists its .ts segments) as bare relative paths with no query string. The
# CloudFront signature is a wildcard over the whole video directory (Policy Resource ends
# in "/*"), so the same Expires/Signature/Key-Pair-Id/Policy query string from the manifest
# URL you pass in is valid for every file under it — but resolving a relative path with
# curl/ffmpeg drops that query string, which causes a 403. This script re-attaches it to
# every sub-manifest/segment reference before muxing with ffmpeg.
#
# Usage: ./scripts/download-nextdoor-video.sh "<signed main .m3u8 URL>" [output.mp4]
#
# Where to get the URL: open the post's video in Chrome DevTools > Network (filter: m3u8)
# while it plays, or run this in the page console:
#   performance.getEntriesByType('resource').find(e => /main-.*\.m3u8/.test(e.name)).name
# Grab the request whose path ends in "main-<hash>.m3u8" under a *.cloudfront.net host —
# it must include Expires/Signature/Key-Pair-Id/Policy query params.
set -euo pipefail

MAIN_URL="${1:?Usage: $0 <signed main .m3u8 URL> [output.mp4]}"
OUTPUT="${2:-nextdoor-video.mp4}"

command -v ffmpeg >/dev/null || { echo "Error: ffmpeg not found on PATH."; exit 1; }
command -v curl >/dev/null || { echo "Error: curl not found on PATH."; exit 1; }

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

if [[ "$MAIN_URL" != *"?"* ]]; then
  echo "Error: URL has no query string — expected a signed CloudFront URL (Expires/Signature/Key-Pair-Id/Policy)."
  exit 1
fi
QS="${MAIN_URL#*\?}"
BASE_URL="${MAIN_URL%%\?*}"
BASE_DIR="${BASE_URL%/*}"

echo "Fetching top-level manifest..."
curl -fsS "$MAIN_URL" -o "$WORKDIR/main.m3u8"

# Pick the highest-BANDWIDTH variant listed (#EXT-X-STREAM-INF followed by its URI line).
VARIANT=$(awk '
  /^#EXT-X-STREAM-INF/ {
    bw = 0
    n = split($0, parts, ",")
    for (i = 1; i <= n; i++) {
      if (parts[i] ~ /BANDWIDTH=/) {
        split(parts[i], kv, "=")
        bw = kv[2] + 0
      }
    }
    getline uri
    if (bw > maxbw) { maxbw = bw; best = uri }
    next
  }
  END { print best }
' "$WORKDIR/main.m3u8")

if [ -z "$VARIANT" ]; then
  echo "No variant streams found in top-level manifest — treating it as the media playlist directly."
  VARIANT_URL="$MAIN_URL"
else
  echo "Selected highest-bandwidth variant: $VARIANT"
  VARIANT_URL="$BASE_DIR/$VARIANT?$QS"
fi

echo "Fetching variant manifest..."
curl -fsS "$VARIANT_URL" -o "$WORKDIR/variant.m3u8"

# Re-sign every bare relative .ts segment reference with the same (wildcard) query string.
awk -v base="$BASE_DIR" -v qs="$QS" '
  /^[^#].*\.ts[[:space:]]*$/ { print base "/" $0 "?" qs; next }
  { print }
' "$WORKDIR/variant.m3u8" > "$WORKDIR/variant_signed.m3u8"

echo "Downloading and muxing to $OUTPUT..."
ffmpeg -y -loglevel error -protocol_whitelist file,http,https,tcp,tls,crypto \
  -i "$WORKDIR/variant_signed.m3u8" -c copy "$OUTPUT"

echo "Done: $OUTPUT"
