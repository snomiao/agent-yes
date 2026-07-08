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
  # bun's installer unpacks a .zip, so it hard-fails with "unzip is required to
  # install bun" on a minimal image (e.g. stock Debian) that ships no unzip.
  # Ensure it first via whatever package manager is present — best-effort, with
  # sudo only when we aren't already root and sudo exists.
  if ! command -v unzip >/dev/null 2>&1; then
    say "Installing unzip (required by the bun installer)…"
    if [ "$(id -u)" = 0 ]; then SUDO=""; elif command -v sudo >/dev/null 2>&1; then SUDO="sudo"; else SUDO=""; fi
    if command -v apt-get >/dev/null 2>&1; then $SUDO apt-get update -qq && $SUDO apt-get install -y -qq unzip
    elif command -v dnf >/dev/null 2>&1; then $SUDO dnf install -y -q unzip
    elif command -v yum >/dev/null 2>&1; then $SUDO yum install -y -q unzip
    elif command -v apk >/dev/null 2>&1; then $SUDO apk add --no-progress unzip
    elif command -v pacman >/dev/null 2>&1; then $SUDO pacman -Sy --noconfirm unzip
    elif command -v zypper >/dev/null 2>&1; then $SUDO zypper -q install -y unzip
    fi
    command -v unzip >/dev/null 2>&1 || err "couldn't install unzip automatically — install it and re-run (e.g. apt-get install unzip)."
  fi
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
say "Installing agent-yes with ${RT}…"
# shellcheck disable=SC2086
$PM agent-yes

# bun blocks dependency postinstalls by default, which skips node-datachannel's
# native build — the addon that powers `ay serve --webrtc` / `ay serve share`.
# Trust it so the WebRTC sharing feature works out of the box. (npm runs
# postinstalls already, so this is bun-only and harmless if it no-ops.)
if [ "$RT" = "bun" ]; then
  bun pm -g trust node-datachannel >/dev/null 2>&1 || true
fi

# --- verify + next steps ----------------------------------------------------
if command -v ay >/dev/null 2>&1; then
  say "Installed: $(ay --version 2>/dev/null || echo agent-yes)"
else
  say "Installed. If 'ay' isn't found, open a new shell (the package bin dir was just added to PATH)."
fi

cat <<'EOF'

  agent-yes is ready. Quick start:

    ay claude            # run Claude with auto-yes
    ay serve --share     # start the web console + a shareable link
    ay ls                # list running agents

  Console & docs: https://agent-yes.com
EOF

# --- offer to start sharing right away --------------------------------------
# curl | sh leaves this script's stdin as the pipe, so read the answer from the
# controlling terminal (/dev/tty). No tty (CI / fully non-interactive) → skip
# silently and let the user run `ay serve --share` themselves. We redirect the
# spawned server's stdin from /dev/tty too, so its own "open the console in your
# browser?" prompt has a terminal to read from.
if command -v ay >/dev/null 2>&1 && [ -r /dev/tty ]; then
  printf '\n\033[36m▸\033[0m Start sharing now and get a console link? [Y/n] ' > /dev/tty
  read -r ans < /dev/tty || ans=""
  case "$ans" in
    [Nn]*) say "Skipped — run 'ay serve --share' when you're ready." ;;
    *)     exec ay serve --share < /dev/tty ;;
  esac
fi
