#!/bin/sh
# agent-yes installer — curl -fsSL https://agent-yes.com/setup.sh | sh
#
# Installs the agent-yes CLI (ay / cy / claude-yes / …) globally. agent-yes is a
# JS package, so it needs a JS runtime + package manager: we use whichever of
# bun / npm you already have, and install bun if you have neither.
set -eu

say() { printf '\033[36m▸\033[0m %s\n' "$1"; }
err() { printf '\033[31m✘ %s\033[0m\n' "$1" >&2; }

# --- pick a package manager -------------------------------------------------
if command -v bun >/dev/null 2>&1; then
  PM="bun add -g"
  RT="bun"
elif command -v npm >/dev/null 2>&1; then
  PM="npm install -g"
  RT="npm"
else
  say "No bun or npm found — installing bun (https://bun.sh)…"
  curl -fsSL https://bun.sh/install | bash
  # Make bun available to the rest of this script.
  BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export BUN_INSTALL
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! command -v bun >/dev/null 2>&1; then
    err "bun install finished but 'bun' is not on PATH — open a new shell and re-run."
    exit 1
  fi
  PM="bun add -g"
  RT="bun"
fi

# --- install ----------------------------------------------------------------
say "Installing agent-yes with $RT…"
# shellcheck disable=SC2086
$PM agent-yes

# --- verify + next steps ----------------------------------------------------
if command -v ay >/dev/null 2>&1; then
  say "Installed: $(ay --version 2>/dev/null || echo agent-yes)"
else
  say "Installed. If 'ay' isn't found, open a new shell (the package bin dir was just added to PATH)."
fi

cat <<'EOF'

  agent-yes is ready. Quick start:

    ay claude            # run Claude with auto-yes
    ay serve share       # start the web console + a shareable link
    ay ls                # list running agents

  Console & docs: https://agent-yes.com
EOF
