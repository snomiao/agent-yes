#!/bin/sh
# agent-yes installer — curl -fsSL https://agent-yes.com/setup.sh | sh
#
# Installs the agent-yes CLI (ay / cy / claude-yes / …) globally. agent-yes is a
# JS package, so it needs a JS runtime + package manager: we use whichever of
# bun / npm you already have, and install bun if you have neither.
set -eu

say() { printf '\033[36m▸\033[0m %s\n' "$1"; }
err() { printf '\033[31m✘ %s\033[0m\n' "$1" >&2; }

# Install an OS package via whatever package manager is present.
#   $1 = command to probe for (skips if already on PATH); $2 = package name.
# Best-effort: sudo only when not already root; DEBIAN_FRONTEND=noninteractive so
# apt/debconf never blocks or spews the dialog→readline fallback noise on a box
# with no tty. Returns success iff the probe command exists afterward. Callers
# invoke it in an `|| …` chain, which also suspends `set -e` for its body so a
# package-manager hiccup degrades gracefully instead of aborting the installer.
os_ensure() {
  probe=$1
  pkg=$2
  command -v "$probe" >/dev/null 2>&1 && return 0
  say "Installing ${pkg} (provides '${probe}')…"
  if [ "$(id -u)" = 0 ]; then _sudo=""; elif command -v sudo >/dev/null 2>&1; then _sudo="sudo"; else _sudo=""; fi
  export DEBIAN_FRONTEND=noninteractive
  if command -v apt-get >/dev/null 2>&1; then $_sudo apt-get update -qq && $_sudo apt-get install -y -qq "$pkg"
  elif command -v dnf >/dev/null 2>&1; then $_sudo dnf install -y -q "$pkg"
  elif command -v yum >/dev/null 2>&1; then $_sudo yum install -y -q "$pkg"
  elif command -v apk >/dev/null 2>&1; then $_sudo apk add --no-progress "$pkg"
  elif command -v pacman >/dev/null 2>&1; then $_sudo pacman -Sy --noconfirm "$pkg"
  elif command -v zypper >/dev/null 2>&1; then $_sudo zypper -q install -y "$pkg"
  fi
  command -v "$probe" >/dev/null 2>&1
}

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
  os_ensure unzip unzip || {
    err "couldn't install unzip automatically — install it and re-run (e.g. apt-get install unzip)."
    exit 1
  }
  curl -fsSL https://bun.sh/install | bash
  # Make bun available to the rest of this script.
  BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export BUN_INSTALL
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! command -v bun >/dev/null 2>&1; then
    err "bun install finished but 'bun' is not on PATH — open a new shell and re-run."
    exit 1
  fi
  # A box with neither bun nor npm also has no Node.js. `ay serve install`
  # bootstraps a process manager, and its universal fallback (pm2, used when
  # oxmgr's native binary can't run — e.g. glibc < 2.39) is a Node.js app, so
  # ensure node now for a fully out-of-the-box `ay serve install`. Best-effort:
  # if it can't be installed, serve-install still prints a clear "pm2 needs node"
  # hint rather than failing mysteriously.
  os_ensure node nodejs ||
    say "node not installed — 'ay serve install' will need it for the pm2 fallback (install nodejs, or use a box with glibc >= 2.39 for oxmgr)."
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
