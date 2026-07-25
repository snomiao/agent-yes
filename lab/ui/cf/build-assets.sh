#!/bin/sh
# Sync the canonical UI (lab/ui/*) into ./public — the single source of truth
# for the site's static assets. Referenced from BOTH wrangler.jsonc's
# build.command (worker deploys: prod agent-yes.com) and the beta Pages deploy
# workflow (.github/workflows/deploy-beta.yml), so the two can never drift.
# Runs from lab/ui/cf/ (wrangler runs build.command from the config's dir).
#
# Layout produced (see wrangler.jsonc for the full commentary):
#   public/w/       — the console PWA (index.html + every UI script)
#   public/index.html, architecture.html, blog/  — landing + docs
#   public/setup.sh, setup.ps1                   — install one-liners
#   public/_headers — CSP for static assets (served before the Worker)
#   public/r/ + public/rgui/ — the rgui forest page (built from lib/rgui)
set -e
mkdir -p ./public/w
cp ../index.html ../ch.html ../*.js ../manifest.webmanifest ../icon.svg ./public/w/
# Vendored xterm.js + addons + css (self-hosted, same-origin — see index.html).
# rm first so a re-run doesn't nest into public/w/vendor/vendor (cp -R into an
# existing dir copies the source dir INSIDE it).
rm -rf ./public/w/vendor && cp -R ../vendor ./public/w/vendor
cp ../landing.html ./public/index.html
cp ../architecture.html ./public/architecture.html
rm -rf ./public/blog
cp -R ../blog ./public/blog
cp ../setup.sh ../setup.ps1 ./public/

# Stamp the console with the deploying commit (index.html's AY_BUILD
# placeholder; "dev" fallback when served raw by `ay serve`). Lets anyone —
# and any agent — verify which frontend a browser is actually running, even
# an offline-cached PWA shell. sed-into-tmp keeps this POSIX (BSD/GNU) safe.
build=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
sed "s/__AY_BUILD__/$build/g" ./public/w/index.html > ./public/w/index.html.tmp
mv ./public/w/index.html.tmp ./public/w/index.html

# Build a channel-specific installer without forking the canonical scripts.
# Production leaves the defaults untouched. Beta Pages passes both variables,
# so curl/PowerShell installs agent-yes@beta and prints the actual beta origin.
if [ "${AGENT_YES_CHANNEL:-stable}" = "beta" ]; then
  origin=${AGENT_YES_ORIGIN:-https://beta.agent-yes.pages.dev}
  sed 's|AY_PACKAGE="agent-yes"|AY_PACKAGE="agent-yes@beta"|; s|AY_CONSOLE_ORIGIN="https://agent-yes.com"|AY_CONSOLE_ORIGIN="'"$origin"'"|' \
    ./public/setup.sh > ./public/setup.sh.tmp
  mv ./public/setup.sh.tmp ./public/setup.sh
  sed "s|\$Package = 'agent-yes'|\$Package = 'agent-yes@beta'|; s|\$ConsoleOrigin = 'https://agent-yes.com'|\$ConsoleOrigin = '$origin'|" \
    ./public/setup.ps1 > ./public/setup.ps1.tmp
  mv ./public/setup.ps1.tmp ./public/setup.ps1
fi
# Channel widget: bundle the browser AyChannel lib (`import AyChannel from
# "agent-yes/channels"`) into a self-contained ESM the hosted chat page (w/ch.html)
# and third-party embeds load. Built with bun (browser target) independent of the
# npm dist build, so it exists even in a bare `wrangler dev` / beta Pages deploy.
bun build ../../../ts/channels/browser.ts --outfile ./public/w/channels.js --format esm --target browser --minify
# Terminal widget: bundle the browser AyTerminal lib (`import AyTerminal from
# "agent-yes/terminal"`) — a self-contained ESM (xterm.js inlined) that any page
# loads to render a live read-only agent terminal (ay term embed). Same browser
# target + independence from the npm dist build as channels.js above.
bun build ../../../ts/terminal/browser.ts --outfile ./public/w/terminal.js --format esm --target browser --minify
# Widget sensor lib (`import { AyWidget } from "agent-yes/widgets"` / agent-yes/widget):
# an in-page agent sensor (selection/dom/screenshot) an agent reads via `ay widget`.
bun build ../../../ts/widget/browser.ts --outfile ./public/w/widget.js --format esm --target browser --minify

cp _headers ./public/_headers
bun ../../../scripts/build-rgui.ts ./public/r
rm -rf ./public/rgui
cp -R ./public/r ./public/rgui
