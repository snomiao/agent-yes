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
cp ../index.html ../*.js ../manifest.webmanifest ../icon.svg ./public/w/
cp ../landing.html ./public/index.html
cp ../architecture.html ./public/architecture.html
rm -rf ./public/blog
cp -R ../blog ./public/blog
cp ../setup.sh ../setup.ps1 ./public/
cp _headers ./public/_headers
bun ../../../scripts/build-rgui.ts ./public/r
rm -rf ./public/rgui
cp -R ./public/r ./public/rgui
