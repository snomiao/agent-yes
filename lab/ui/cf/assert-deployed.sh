#!/bin/sh
# Assert that a site is actually SERVING the commit we just deployed.
#
#   sh ./assert-deployed.sh <origin> <sha>
#
# Why this exists: `wrangler deploy` exiting 0 does not mean the new bytes are
# live, and every prod incident so far has had the same shape — nothing red,
# the site just stale:
#
#   * a promote moved `release` and the deploy never ran at all (#271), so prod
#     kept serving the previous build with a green tick next to it;
#   * a deploy dispatched 1.3s after its own push resolved the ref to the
#     PRE-push commit, redeployed the old site, and reported success — the
#     console served a stale service worker for hours.
#
# Neither is visible in a diff, so no amount of review catches them; only
# asking the live origin what it is running does. build-assets.sh stamps the
# short SHA into public/w/index.html (the `__AY_BUILD__` placeholder), so the
# deployed console can be interrogated over plain HTTP.
#
# Exits 0 only when the origin serves <sha>. A surviving `__AY_BUILD__`
# placeholder (an unstamped/dev copy) never matches, so it fails too.
set -eu

ORIGIN=${1:?usage: assert-deployed.sh <origin> <sha>}
SHA=${2:?usage: assert-deployed.sh <origin> <sha>}

# build-assets.sh stamps `git rev-parse --short HEAD`. Compare on that prefix so
# a caller may pass either a full 40-char SHA or an already-short one. Git's
# short length is not fixed (it grows to stay unambiguous), so take the length
# of whatever the site reports rather than assuming 7.
ATTEMPTS=${ASSERT_ATTEMPTS:-20}
SLEEP=${ASSERT_SLEEP:-15}

echo "asserting $ORIGIN serves $SHA"

i=1
while [ "$i" -le "$ATTEMPTS" ]; do
  # Shared reader (cache-busted) so this and promote-release.yml's beta gate
  # can never parse the stamp differently.
  live=$(sh "$(dirname "$0")/live-build.sh" "$ORIGIN" || true)

  if [ -n "$live" ]; then
    n=$(printf '%s' "$live" | wc -c | tr -d ' ')
    want=$(printf '%s' "$SHA" | cut -c "1-$n")
    if [ "$live" = "$want" ]; then
      echo "ok: $ORIGIN serves $live"
      exit 0
    fi
    echo "  attempt $i/$ATTEMPTS: serving $live, want $want"
  else
    echo "  attempt $i/$ATTEMPTS: no build stamp in response (origin down, or /w/ not deployed)"
  fi

  i=$((i + 1))
  [ "$i" -le "$ATTEMPTS" ] && sleep "$SLEEP"
done

echo "::error::$ORIGIN did not serve $SHA after $ATTEMPTS attempts — last saw '${live:-<none>}'."
echo "The deploy reported success but the site is stale. Do NOT promote this commit."
exit 1
