# Agent-Yes Architecture

## Overview

Agent-yes is a robust CLI automation wrapper for AI agent tools (Claude, Codex, Gemini). The codebase has been refactored for maintainability, with core logic extracted into focused modules.

## Module Structure

```
ts/
├── index.ts                    # Main orchestrator (~627 lines)
├── cli.ts                      # CLI argument parsing
├── core/                       # Core modules (extracted from index.ts)
│   ├── context.ts              # AgentContext - Shared session state
│   ├── spawner.ts              # Process spawning & installation
│   ├── messaging.ts            # Message sending utilities
│   ├── logging.ts              # Log path management
│   ├── responders.ts           # Auto-response pattern handlers
│   └── streamHelpers.ts        # Stream processing utilities
├── resume/                     # Session resumption
│   └── codexSessionManager.ts  # Codex session persistence
├── pidStore.ts                 # Process registry & management
├── logger.ts                   # Winston logger setup
├── idleWaiter.ts               # Idle detection utility
├── ReadyManager.ts             # Async ready state manager
└── beta/                       # Experimental features
    └── fifo.ts                 # FIFO inter-process communication
```

## Core Modules

### 1. context.ts - AgentContext Class

**Purpose:** Centralized state management for agent sessions

**Responsibilities:**

- Store PTY shell instance and configuration
- Manage state flags (isFatal, shouldRestartWithoutContinue)
- Provide ReadyManager instances (stdinReady, nextStdout)
- Expose messageContext for communication utilities

**Key Pattern:** Context object pattern - groups related state for easy passing between modules

### 2. spawner.ts - Process Spawning

**Purpose:** Handle CLI process creation with error handling

**Key Functions:**

- `spawnAgent()` - Create PTY process with retry logic
- `getInstallCommand()` - Platform-specific install command selection
- `getTerminalDimensions()` - TTY size with fallbacks

**Features:**

- Auto-install missing CLIs (npm/platform-specific)
- Command-not-found error detection
- bun-pty compatibility fixes

### 3. messaging.ts - Communication

**Purpose:** Send messages and simulate keyboard input to agent

**Key Functions:**

- `sendMessage()` - Send text with Enter key, wait for response
- `sendEnter()` - Send Enter with idle wait and retries

**Pattern:** Async/await with exponential retry (1s, 3s)

### 4. logging.ts - Log Management

**Purpose:** Manage log file paths and output

**Key Functions:**

- `initializeLogPaths()` - Generate log paths from PID
- `setupDebugLogging()` - Configure winston file transport
- `saveLogFile()` - Write rendered terminal output

**Log Types:**

- `.log` - Clean rendered output
- `.raw.log` - Raw with control chars
- `.debug.log` - Debug messages (winston)

### 5. responders.ts - Auto-Response Logic

**Purpose:** Pattern-based CLI output analysis and auto-responses

**Response Types:**

1. **Ready signals** - Detect when agent is ready for input
2. **Enter automation** - Auto-press Enter at prompts
3. **Typing responses** - Send configured text to patterns
4. **Fatal errors** - Trigger exit on error patterns
5. **Session capture** - Extract and store session IDs (Codex)

**Configuration-Driven:** All patterns defined in `agent-yes.config.ts`

### 6. streamHelpers.ts - Stream Processing

**Purpose:** Terminal I/O stream transformations

**Key Functions:**

- `handleConsoleControlCodes()` - Cursor position, device attributes
- `createTerminateSignalHandler()` - CTRL+C/CTRL+Z handling
- `createTerminatorStream()` - Auto-terminate on exit

**Control Codes Handled:**

- `ESC[6n` - Cursor position request
- `ESC[c` - Device attributes query
- `\u0003` - SIGINT (CTRL+C)
- `\u001A` - SIGTSTP (CTRL+Z, filtered)

## Data Flow

```
┌─────────────────┐
│   User Input    │
│  (stdin/FIFO)   │
└────────┬────────┘
         │
         ▼
┌─────────────────────────┐
│  Signal Handler         │
│  (CTRL+C detection)     │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  Stdin Ready Manager    │
│  (wait for agent ready) │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│   PTY Shell (Agent)     │
│   (claude/codex/etc)    │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  Output Stream          │
│  (raw PTY output)       │
└────────┬────────────────┘
         │
         ├──► Raw Logger (optional)
         │
         ▼
┌─────────────────────────┐
│  Console Responder      │
│  (cursor position, DA)  │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  Auto-Response Handler  │
│  (pattern matching)     │
└────────┬────────────────┘
         │
         ├──► Ready signals → Mark stdin ready
         ├──► Enter patterns → Send Enter
         ├──► Fatal errors → Exit agent
         └──► Session IDs → Store for resume
         │
         ▼
┌─────────────────────────┐
│  Control Char Remover   │
│  (optional, non-TTY)    │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│   User stdout           │
└─────────────────────────┘
```

## State Management

### ReadyManager Pattern

Used for coordinating async readiness states:

```typescript
const stdinReady = new ReadyManager();

// Wait for ready
await stdinReady.wait();

// Mark as ready (from another context)
stdinReady.ready();

// Check state
if (stdinReady.isReady) { ... }
```

**Usage:**

- `stdinReady` - Agent is ready for input
- `nextStdout` - Next output chunk received
- `stdinFirstReady` - First ready signal (for initial prompt)

### Context Flags

```typescript
ctx.isFatal; // Fatal error detected, exit on crash
ctx.shouldRestartWithoutContinue; // Restart without --continue flag
ctx.robust; // Auto-restart on crash
```

## Session Management

### Crash Recovery (Robust Mode)

When `robust: true`:

1. Agent crashes → `shell.onExit()` triggered
2. Check `ctx.isFatal` → if false, restart with `restoreArgs`
3. For Codex: Use stored session ID instead of `--last`
4. Re-register process in pidStore
5. Continue from previous state

### Session Resumption

**Codex:** Session IDs stored per-directory in `.claude/sessions.db`

- Captured from output via regex
- Restored on crash or explicit `--resume`

**Claude:** Uses built-in `--continue` flag

**Gemini:** Uses native `--resume` with project-scoped sessions

## Testing Strategy

**Unit Tests:**

- `catcher.spec.ts` - Error handler wrapper
- `idleWaiter.spec.ts` - Idle detection
- `ReadyManager.spec.ts` - Ready state manager
- `removeControlCharacters.spec.ts` - ANSI stripping

**Integration Tests:**

- `session-integration.spec.ts` - Session ID extraction
- `codex-resume.spec.ts` - Session restoration
- `runningLock.spec.ts` - Process locking

**Coverage:** 122 tests, ~58% overall (core modules added but not yet covered)

## Configuration

### CLI Configuration (`agent-yes.config.ts`)

```typescript
export default {
  clis: {
    claude: {
      ready: [/Ready for input/],
      fatal: [/Fatal error/],
      enter: [/Press Enter/],
      exitCommands: ["/exit"],
      promptArg: "first-arg",
      restoreArgs: ["--continue"],
    },
  },
};
```

**Pattern Types:**

- `ready: RegExp[]` - Mark stdin ready
- `fatal: RegExp[]` - Trigger exit
- `enter: RegExp[]` - Auto-press Enter
- `typingRespond: { [text: string]: RegExp[] }` - Send text on pattern
- `exitCommands: string[]` - Graceful exit commands
- `restoreArgs: string[]` - Args for crash recovery

## Extension Points

### Adding New CLI Support

1. Add configuration to `agent-yes.config.ts`
2. Test ready/exit patterns
3. Add to `SUPPORTED_CLIS` type
4. Update tests

### Custom Auto-Responses

Add to `typingRespond` in config:

```typescript
typingRespond: {
  'yes': [/Do you want to continue/],
  'n': [/Delete everything/]
}
```

### Session Management

Implement in `resume/` directory:

- Extend `SessionManager` pattern from `codexSessionManager.ts`
- Hook into `createAutoResponseHandler()` for ID capture

## Performance Considerations

### Stream Processing

- Uses Web Streams API for backpressure handling
- Minimal buffering via `TransformStream`
- Parallel stream forks for logging (`.forkTo()`)

### Process Registry

- SQLite database (`pidStore.ts`) for cross-process coordination
- Lock-free reads for status queries
- Atomic writes for state updates

### Logging

- Winston async file writes (non-blocking)
- Optional raw logging (can be huge)
- Terminal rendering cached in memory

## Future Improvements

1. **Phase 4+:** Further extraction
   - Stream pipeline builder pattern
   - Plugin system for custom CLIs
   - Event emitter architecture

2. **Testing:**
   - Unit tests for core modules (spawner, responders, etc.)
   - Mock PTY for integration tests
   - CI/CD test coverage enforcement

3. **Features:**
   - Pause/resume support (CTRL+Z)
   - Multi-session management UI
   - WebSocket remote control
   - Cloud session sync

## Migration Guide

### Before Refactoring (876 lines in index.ts)

```typescript
// Everything in one file
export default async function agentYes(...) {
  // 800+ lines of mixed concerns
}
```

### After Refactoring (627 lines + 6 modules)

```typescript
import { spawnAgent } from './core/spawner.ts';
import { AgentContext } from './core/context.ts';
import { createAutoResponseHandler } from './core/responders.ts';

export default async function agentYes(...) {
  // Orchestration only
  const shell = spawnAgent(...);
  const ctx = new AgentContext(...);

  stream
    .forEach(line => createAutoResponseHandler(line, ...))
    .to(stdout);
}
```

### Benefits Achieved

- **Testability:** Modules can be unit tested in isolation
- **Maintainability:** Single Responsibility Principle
- **Readability:** Clear separation of concerns
- **Extensibility:** Easy to add new CLIs or features
- **Code Reuse:** Utilities can be imported elsewhere

## Conclusion

The refactoring transformed a monolithic 876-line file into a modular architecture with clear responsibilities. The core orchestrator (index.ts) is now focused on high-level flow, while specialized modules handle spawning, messaging, logging, auto-responses, and stream processing. This structure supports future enhancements while maintaining backward compatibility.
