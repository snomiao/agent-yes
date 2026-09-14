# agent-yes installer (Windows) — powershell -c "irm <site-origin>/setup.ps1 | iex"
# (the powershell -c wrapper lets the same one-liner run from cmd too)
#
# Installs the agent-yes CLI (ay / cy / claude-yes / …) globally. agent-yes is a
# JS package, so it needs a JS runtime + package manager: we use whichever of
# bun / npm you already have, and install bun if you have neither.
#
# A room link in $env:AY_JOIN attaches this machine to that room once installed
# — the console's "pair a machine" button builds the whole command, secret and
# all, from a fragment that never reaches a server:
#
#   $env:AY_JOIN='https://…/room/#room=…&s=…'; irm …/setup.ps1 | iex
#
# NOT wrapped in `powershell -c "…"` the way the plain one-liner is. That
# wrapper is what lets the plain form also run from cmd, but here it breaks:
# pasted into PowerShell, the OUTER shell expands $env:AY_JOIN inside the double
# quotes — to nothing, since it isn't set yet — and the inner shell is left with
# `='https://…'`. The environment is also the right place for the secret: an
# argument would sit in the command line for any process listing to read.
$ErrorActionPreference = 'Stop'

# Beta site builds rewrite these defaults in build-assets.sh.
$Package = 'agent-yes'
$ConsoleOrigin = 'https://agent-yes.com'

$Join = $env:AY_JOIN
# --fleet/AY_FLEET (many machines, one reusable token) is POSIX-only: it needs
# codehost + a service manager this script doesn't set up. Say so rather than
# installing and silently ignoring it.
if ($env:AY_FLEET) {
  Write-Error 'AY_FLEET is not supported on Windows yet — use AY_JOIN with a room link, or run setup.sh on a POSIX host.'
  exit 1
}

function Say($m) { Write-Host "▸ $m" -ForegroundColor Cyan }

# --- pick a package manager -------------------------------------------------
if (Get-Command bun -ErrorAction SilentlyContinue) {
  $pm = { bun add -g $Package }
  $rt = 'bun'
} elseif (Get-Command npm -ErrorAction SilentlyContinue) {
  $pm = { npm install -g $Package }
  $rt = 'npm'
} else {
  Say 'No bun or npm found — installing bun (https://bun.sh)…'
  Invoke-RestMethod bun.sh/install.ps1 | Invoke-Expression
  $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Error "bun install finished but 'bun' is not on PATH — open a new terminal and re-run."
    exit 1
  }
  $pm = { bun add -g $Package }
  $rt = 'bun'
}

# --- install ----------------------------------------------------------------
Say "Installing $Package with $rt…"
& $pm

# A fresh `bun add -g` writes into ~\.bun\bin, which is only on PATH for shells
# started after bun's own installer ran — so on a box where bun was already
# present but never used interactively, `ay` resolves nowhere despite a clean
# install. Prepend the known bin dir before deciding it's missing. (npm's global
# prefix varies too much to guess, and is normally on PATH already.)
if ($rt -eq 'bun' -and -not (Get-Command ay -ErrorAction SilentlyContinue)) {
  $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
}

# --- join a room, if one was handed to us ------------------------------------
# An explicit room means the operator already decided; don't stop to ask. This
# runs in the foreground and does not return, so it must come before the
# generic next-steps block.
if ($Join) {
  if (-not (Get-Command ay -ErrorAction SilentlyContinue)) {
    Write-Error "installed, but 'ay' is not on PATH yet — open a new terminal and run: ay serve --webrtc '$Join'"
    exit 1
  }
  Say 'Joining room…'
  & ay serve --webrtc $Join
  exit $LASTEXITCODE
}

# --- next steps -------------------------------------------------------------
Say 'agent-yes is ready. Quick start:'
@"

    ay claude            # run Claude with auto-yes
    ay serve share       # start the web console + a shareable link
    ay ls                # list running agents

  Console & docs: $ConsoleOrigin
  (If "ay" isn't found, open a new terminal — the package bin dir was just added to PATH.)
"@ | Write-Host
