# Cold Start Optimization

## Before / After

| Metric                      | Before | After  | Improvement |
| --------------------------- | ------ | ------ | ----------- |
| `--version` wall time (avg) | 209 ms | 89 ms  | **−57%**    |
| `--version` wall time (min) | 185 ms | 76 ms  | **−59%**    |
| `--version` wall time (max) | 230 ms | 105 ms | **−54%**    |
| RSS at exit                 | 83 MB  | 60 MB  | **−28%**    |

Measured with `node dist/agent-yes.js --version`, 7 runs, macOS arm64, Node 22.

---

## Root Cause

The previous static import chain forced every module in `index.ts` to be evaluated on every invocation, even for fast-exit paths like `--version`:

```
cli.ts
  → parseCliArgs.ts
      → SUPPORTED_CLIS.ts
          → index.ts          ← 56 KB chunk
              → @xterm/headless
              → sflow
              → execa  (×2)
              → from-node-stream
              → proper-lockfile
              → winston
              → bun-pty / node-pty (top-level await)
  → logger.ts
      → winston               ← synchronous init
  → versionChecker.ts
      → execa                 ← never used on --version path
  → pidStore.ts
      → JsonlStore.ts
          → proper-lockfile
```

---

## Changes Made

### 1. Break `parseCliArgs → SUPPORTED_CLIS → index.ts` chain

**`ts/parseCliArgs.ts`**

- Removed `import { SUPPORTED_CLIS } from "./SUPPORTED_CLIS.ts"`
- Added optional `supportedClis?: readonly string[]` parameter
- `choices` validation is `undefined` (no constraint) unless caller passes it

**`ts/cli.ts`**

- Removed static `import { SUPPORTED_CLIS }` — now dynamic import inside the `--rust` branch only
- Removed static `import { PidStore }` — now dynamic import inside the `--append-prompt` branch only
- Added ultra-fast early exit for `--version` / `-v` before `checkAndAutoUpdate()` and yargs parsing

This single change eliminates the entire `index.ts` transitive closure (~56 KB, xterm/sflow/execa/pty/proper-lockfile) from startup.

### 2. Lazy winston logger

**`ts/logger.ts`**

- Replaced synchronous `import winston; winston.createLogger(...)` with a lazy proxy
- First log call triggers `import("winston")` asynchronously; messages are queued until it resolves
- Exported `flushLogger()` — awaitable drain for call sites that `process.exit()` after logging
- Exported `addTransport()` — async version of `logger.add()` that awaits init before adding

**`ts/core/logging.ts`**

- `setupDebugLogging` made `async`; uses `addTransport` + dynamic `import("winston")` for the File transport
- Removes the static `import winston` (winston is no longer a startup dependency of index.ts)

**`ts/index.ts`**

- `await setupDebugLogging(...)` (was sync call)

### 3. Lazy `execa` in versionChecker

**`ts/versionChecker.ts`**

- Removed top-level `import { execaCommand } from "execa"`
- `execaCommand` is now `await import("execa")` inside `runInstall()`, which only runs when an update is available (rare)

---

## Module load profile (after)

Modules loaded for `--version` (static, at startup):

| Module                              | Why                          |
| ----------------------------------- | ---------------------------- |
| `yargs` + `ms`                      | `parseCliArgs` (always runs) |
| `child_process`, `fs`, `os`, `path` | node built-ins               |
| `logger-*.js` (1.5 KB)              | proxy stub, no winston       |
| `package-*.js` (0.2 KB)             | version string               |

Modules loaded lazily (only when needed):

| Module                                                  | When                                          |
| ------------------------------------------------------- | --------------------------------------------- |
| `winston`                                               | First `logger.*()` call after fast-path exits |
| `@xterm/headless`, `sflow`, `execa`, `from-node-stream` | `await import("./index.ts")` (full session)   |
| `proper-lockfile`                                       | `--append-prompt` path (via PidStore)         |
| `SUPPORTED_CLIS` / `index.ts`                           | `--rust` path                                 |
| `bun-pty` / `node-pty`                                  | PTY session start                             |
