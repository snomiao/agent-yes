# agent-yes installer (Windows) — powershell -c "irm <site-origin>/setup.ps1 | iex"
# (the powershell -c wrapper lets the same one-liner run from cmd too)
#
# Installs the agent-yes CLI (ay / cy / claude-yes / …) globally. agent-yes is a
# JS package, so it needs a JS runtime + package manager: we use whichever of
# bun / npm you already have, and install bun if you have neither.
$ErrorActionPreference = 'Stop'

# Beta site builds rewrite these defaults in build-assets.sh.
$Package = 'agent-yes'
$ConsoleOrigin = 'https://agent-yes.com'

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

# --- next steps -------------------------------------------------------------
Say 'agent-yes is ready. Quick start:'
@"

    ay claude            # run Claude with auto-yes
    ay serve share       # start the web console + a shareable link
    ay ls                # list running agents

  Console & docs: $ConsoleOrigin
  (If "ay" isn't found, open a new terminal — the package bin dir was just added to PATH.)
"@ | Write-Host
