# UI Test — xterm.js + Playwright + Gemini

Renders agent-yes PTY output inside **xterm.js** in a headless Chromium browser,
takes screenshots at multiple terminal sizes, and uses **Gemini Vision** to judge
whether the rendering looks correct.

## Purpose

- Catch PTY width/resize rendering regressions visually
- Detect ANSI colour corruption, UTF-8 garbling, font issues
- Provide a ground-truth screenshot of what users actually see

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Playwright (headless Chromium)                       │
│  ┌────────────────────────────────────────────────┐   │
│  │  tests/ui-test/index.html                      │   │
│  │  xterm.js 5.x  ←─ WebSocket ─────┐            │   │
│  └────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
         │ screenshots (PNG)
         ▼
  Gemini Vision API  →  PASS / FAIL verdict
         │
┌────────┴──────────────────────────────────────────────┐
│  Bun WebSocket server  (tests/ui-test/server.ts)       │
│  Spawns the mock CLI (or real agent-yes)               │
│  Pipes stdout → WebSocket → xterm.js                   │
└───────────────────────────────────────────────────────┘
```

## Files

| File                             | Description                                                         |
| -------------------------------- | ------------------------------------------------------------------- |
| `tests/ui-test/server.ts`        | HTTP + WebSocket server (Node-compatible, serves HTML & fonts)      |
| `tests/ui-test/index.html`       | xterm.js frontend, WebSocket client                                 |
| `tests/ui-test/mock-cli.ts`      | Demo CLI that emits ANSI colors, Unicode box-drawing, progress bars |
| `tests/ui-test/ui.test.ts`       | Playwright + Gemini Vision tests                                    |
| `tests/ui-test/vitest.config.ts` | Separate vitest config (excluded from main test suite)              |
| `tests/ui-test/screenshots/`     | Last-run screenshots (git-ignored)                                  |

## Prerequisites

```bash
# Install Playwright browsers
bunx playwright install chromium

# Install JetBrains Mono system font (for correct box-drawing rendering)
sudo apt-get install fonts-jetbrains-mono   # Debian/Ubuntu
# or: brew install font-jetbrains-mono      # macOS

# Set Gemini API key
echo 'GEMINI_API_KEY=your-key-here' >> .env.local
```

## Running

```bash
# Run via npm script
bun run test:ui

# Or directly
bunx vitest run --config tests/ui-test/vitest.config.ts

# Start the server interactively (browse at http://localhost:3737)
bun tests/ui-test/server.ts
```

## Test Cases

| Name             | Size   | What it tests                                     |
| ---------------- | ------ | ------------------------------------------------- |
| `standard-80x24` | 80×24  | Classic terminal size, word-wrap, table alignment |
| `wide-120x30`    | 120×30 | Wide terminal, full-width header box, long text   |
| `narrow-40x20`   | 40×20  | Narrow terminal, aggressive wrapping, UTF-8       |

## Gemini Model

Uses **gemini-2.5-flash** by default (~3-5s per call).
Change `GEMINI_MODEL` env var to use a different model, e.g. `gemini-3-pro-preview`
(much slower, ~60-90s per call — useful for deeper analysis).

## Known Rendering Notes

- **Box-drawing gaps**: At lineHeight < 1.1, thin gaps can appear between `─` chars.
  Fixed by setting `lineHeight: 1.1` in xterm.js config.
- **UTF-8 multi-byte**: Must pass `Uint8Array` (not binary string) to `term.write()`.
  Passing a JS string corrupts multi-byte sequences like `╔` → `â`.
- **Font loading**: Google Fonts CDN is unavailable in headless mode.
  The server serves JetBrains Mono directly from the system font path.
