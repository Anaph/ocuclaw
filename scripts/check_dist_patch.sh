#!/bin/sh
# Guard: dist-cjs is a COMPILED bundle and the beforeId pagination patch is
# hand-applied here. An upstream TS rebuild can silently drop it; fail loudly
# instead of shipping a bridge that ignores beforeId.
set -u
BRIDGE="$(cd "$(dirname "$0")/.." && pwd)/dist-cjs/runtime/hermes-gateway-bridge.cjs"
fail=0
for marker in beforeId nextBeforeId hasMore; do
  grep -q "$marker" "$BRIDGE" || { echo "check_dist_patch: MISSING '$marker' in $BRIDGE" >&2; fail=1; }
done
if [ "$fail" -ne 0 ]; then
  echo "The dist-cjs bridge lost the db.chat.history pagination patch (rebuilt from TS upstream?)." >&2
  exit 1
fi
echo "check_dist_patch OK"
