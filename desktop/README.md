# agent-yes desktop (Electron)

An offline desktop shell for the agent-yes console. It bundles the same UI as the
web app (`/w/`) plus the `agent-yes` CLI, and runs entirely on your machine — **no
`s.agent-yes.com` signaling server required**.

## How it works

The public web console uses Cloudflare signaling only to connect a browser to a
host on a _different_ machine. On the desktop the browser (this window) and the
host live on the **same** machine, so there's no WebRTC and no cloud at all:

1. `main.js` picks a free port and a random auth token.
2. It spawns `ay serve --http --host 127.0.0.1 --port <free> --token <token>`.
   That serves the console UI and the `/api` endpoints straight from the CLI.
3. The window loads `http://127.0.0.1:<port>/#k=<token>` — the page reads the
   token from the hash and drives the local API directly.

Same UI assets, same API — just pointed at a loopback host instead of the cloud.

## Develop

From a source checkout (with the repo already built so `../dist` exists):

```bash
bun run build          # at the repo root — produces ../dist/agent-yes.js
cd desktop
npm install
npm start              # launches Electron; spawns the repo's ay serve via bun
```

`main.js` resolves the CLI in this order:

1. `AY_BIN` env — the executable (verbatim, so paths with spaces work), with
   optional `AY_BIN_ARGS` for leading args, e.g. `AY_BIN=ay` or
   `AY_BIN=bun AY_BIN_ARGS=/path/agent-yes.js`.
2. A bundled copy inside a packaged app (`resources/ay/dist/agent-yes.js`, via `bun`).
3. The repo's own `../dist/agent-yes.js` (dev), via `bun`.
4. `ay` on your `PATH` (a global `npm i -g agent-yes` / `bun link` install).

## Package

```bash
npm run bundle        # stage the CLI into ./vendor/ay (needs bun + a built repo)
npm run dist          # electron-builder → installers under ./dist
npm run dist:dir      # unpacked app dir (faster, for smoke tests)
```

`bundle-cli.mjs` copies the built CLI + UI assets + config into `vendor/ay` and
installs its runtime deps; electron-builder ships that as `resources/ay`.

> **Self-contained caveat:** packaged builds currently expect `bun` to be present
> (the staged CLI is run with `bun`, which keeps us on bun-pty's FFI path and
> avoids a Node-ABI native rebuild). Bundling a `bun` binary so end users need
> nothing pre-installed is the next packaging step — see `bundle-cli.mjs`.

## Local models (LM Studio / Ollama)

The desktop shell needs no cloud. To make the _agents_ it manages run against a
local model, point the underlying CLI at an OpenAI-compatible local endpoint
before launching, e.g.:

```bash
# Ollama (default :11434) — OpenAI-compatible at /v1
export OPENAI_BASE_URL=http://127.0.0.1:11434/v1
export OPENAI_API_KEY=ollama            # any non-empty value

# LM Studio — Developer ▸ Start Server (default :1234)
export OPENAI_BASE_URL=http://127.0.0.1:1234/v1
export OPENAI_API_KEY=lmstudio
```

Then spawn an agent CLI that honors those (e.g. `codex`, `opencode`) from the
console as usual. A first-class local-model picker in the UI is a follow-up.

## Status

Foundation scaffold. The offline host path (`ay serve --http`) is verified; the
Electron shell needs real-device testing (it cannot run headless in CI). Remaining:
bundle `bun` for a no-prereq install, code-signing, and the local-model picker.
