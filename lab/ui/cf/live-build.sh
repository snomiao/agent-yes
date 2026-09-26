#!/bin/sh
# Print the short commit SHA a deployed site is actually serving, or nothing if
# it can't be determined.
#
#   sh ./live-build.sh <origin>        # -> e.g. 37a3fef
#
# build-assets.sh stamps `git rev-parse --short HEAD` into public/w/index.html
# over the `__AY_BUILD__` placeholder, so the console carries its own build id:
#
#   window.AY_BUILD = /^__/.test("37a3fef") ? "dev" : "37a3fef";
#
# One reader, two callers (assert-deployed.sh and promote-release.yml's beta
# gate) so the parse can't drift in one of them. An unstamped copy still has the
# `__AY_BUILD__` placeholder, which is deliberately returned as-is: it is not a
# SHA, so every caller comparing it against one fails — which is correct, that
# copy was never deployed.
set -eu

ORIGIN=${1:?usage: live-build.sh <origin>}

# Cache-bust: Cloudflare can still serve the previous asset from an edge cache
# just after a deploy, and a cached 200 would report the OLD build as live.
curl -fsS -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
  "$ORIGIN/w/?__build=$(date +%s)$$" 2>/dev/null |
  sed -n 's/.*window\.AY_BUILD = \/\^__\/\.test("\([^"]*\)").*/\1/p' |
  head -1
