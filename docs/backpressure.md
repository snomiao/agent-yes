# Backpressure Behavior

How agent-yes handles data flow, buffering, and backpressure in both TypeScript and Rust implementations.

## Overview

Both implementations share the same core design principle: **agent reliability over output completeness**. The agent CLI process must never be blocked by slow consumers (stdout, logging, network). When pressure builds, old output is discarded rather than stalling the agent.

Neither implementation uses true end-to-end backpressure. Instead, they use:

- **Unbounded/large channels** between PTY and main loop (never block the agent)
- **Ready/idle state gating** as flow control for input (pseudo-backpressure)
- **Bounded output channels** with drop-and-warn on overflow

---

## Data Flow Architecture

```
                    ┌──────────────────────┐
                    │    Agent CLI Process  │
                    │  (claude, gemini, …)  │
                    └──────┬───────▲───────┘
                      PTY  │stdout │stdin
                    ┌──────▼───────┴───────┐
                    │     PTY Master        │
                    │  (OS buffer ~64KB)    │
                    └──────┬───────▲───────┘
                           │       │
              ┌────────────▼──┐ ┌──┴────────────┐
              │ Output Reader │ │  Input Writer  │
              │  (thread/cb)  │ │ (gated by      │
              └──────┬────────┘ │  ready state)  │
                     │          └──▲─────────────┘
              ┌──────▼────────┐    │
              │ Main Loop     ├────┘
              │ (pattern match│
              │  heartbeat)   │
              └──────┬────────┘
                     │
              ┌──────▼────────┐
              │ Stdout/Display│
              │ (bounded buf) │
              └───────────────┘
```

---

## TypeScript Implementation

### Output Path (PTY → Display)

```
PTY stdout → shell.onData(callback) → TerminalRenderStream.writable → process.stdout
```

| Stage                          | Buffering                            | Backpressure                         |
| ------------------------------ | ------------------------------------ | ------------------------------------ |
| `shell.onData()`               | None — callback fires eagerly        | **None** — PTY always drained        |
| `outputWriter.write(data)`     | Web Streams internal (~16KB default) | **None** — return value ignored      |
| `TerminalRenderStream`         | Internal terminal state buffer       | **None** — never exerts backpressure |
| `process.stdout`               | OS pipe buffer                       | Implicit (blocks if pipe full)       |
| `agentRegistry.appendStdout()` | Circular buffer, 1000 lines max      | Bounded — old lines evicted          |
| Raw file logging (`forkTo`)    | Async `writeFile` with append        | **None** — errors silently caught    |

**Key code** (`ts/index.ts:391-398`):

```typescript
function onData(data: string) {
  outputWriter.write(data); // return value ignored — no backpressure
  globalAgentRegistry.appendStdout(currentPid, data);
}
```

### Input Path (User → PTY)

```
process.stdin → ReadableStream(highWaterMark: 16) → sflow transforms → WritableStream → shell.write()
```

Flow is gated by **ReadyManager** and **IdleWaiter**:

| Gate                  | Mechanism                        | Purpose                                 |
| --------------------- | -------------------------------- | --------------------------------------- |
| `stdinReady.wait()`   | Promise-based gate               | Wait until CLI shows ready pattern      |
| `idleWaiter.wait(ms)` | Polling (100ms interval)         | Wait for quiet period before sending    |
| `nextStdout.wait()`   | Promise-based gate (30s timeout) | Wait for response before next message   |
| 10s force-ready       | `sleep(10e3).then(...)`          | Fallback if ready pattern never matches |

**Key code** (`ts/core/messaging.ts:70-87`):

```typescript
await context.stdinReady.wait();       // gate: wait for ready
context.shell.write(message + "\n");   // return value ignored
context.idleWaiter.ping();
await Promise.race([                   // gate: wait for output (with 30s timeout)
  context.nextStdout.wait(),
  new Promise(resolve => setTimeout(() => { warn(...); resolve(); }, 30000)),
]);
```

### Buffer Sizes

| Buffer                            | Size                   | Location              |
| --------------------------------- | ---------------------- | --------------------- |
| Web Streams default highWaterMark | ~16KB                  | outputWriter          |
| stdinStream highWaterMark         | 16 chunks              | Input ReadableStream  |
| Agent registry circular buffer    | 1000 lines             | `ts/agentRegistry.ts` |
| PTY OS buffer                     | ~4–64KB (OS-dependent) | Kernel                |

### What Happens Under Pressure

| Scenario                             | Behavior                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Fast PTY output, slow stdout**     | Data accumulates in TerminalRenderStream. PTY OS buffer may fill, causing kernel to block the agent CLI. No application-level mitigation. |
| **shell.write() to full PTY buffer** | Write may silently fail or block. Return value not checked. Message potentially dropped.                                                  |
| **Slow disk I/O (file logging)**     | `writeFile` errors caught silently. Memory accumulates in stream pipeline.                                                                |
| **Ready pattern never matches**      | Input blocked until 10s force-ready timeout fires.                                                                                        |
| **nextStdout never arrives**         | `sendMessage()` logs a warning and continues after 30s timeout.                                                                           |

---

## Rust Implementation

### Output Path (PTY → Display)

```
PTY stdout → thread read(8KB) → unbounded_channel → main loop → bounded_channel(1250) → stdout task
```

| Stage                     | Buffering                    | Backpressure                                  |
| ------------------------- | ---------------------------- | --------------------------------------------- |
| PTY read thread           | 8KB stack buffer             | **None** — unbounded channel send             |
| `mpsc::unbounded_channel` | Unlimited heap               | **None by design** — reader never blocks      |
| Main loop `try_recv()`    | In-memory buffer, ~100KB cap | Truncation at 50KB boundary                   |
| `mpsc::channel(1250)`     | 1250 items (~10MB)           | **Soft** — `try_send()` drops on full + warns |
| Stdout writer task        | Async `stdout().write_all()` | OS pipe backpressure                          |

**Key code** (`rs/src/pty_spawner.rs:151-155`):

```rust
// Must be unbounded so the reader thread never blocks.
// If stdout isn't being read, backpressure must NOT propagate to the agent CLI.
// The agent must keep running regardless.
let (output_tx, output_rx) = mpsc::unbounded_channel::<String>();
```

**Output drop on overflow with warning** (`rs/src/context.rs:284-296`):

```rust
match stdout_tx.try_send(chunk.clone()) {
    Ok(_) => {}
    Err(TrySendError::Full(_)) => {
        self.stdout_drop_count += 1;
        if self.stdout_drop_count == 1 || self.stdout_drop_count % 100 == 0 {
            warn!("stdout channel full, dropped output ({} total drops)", self.stdout_drop_count);
        }
    }
    Err(TrySendError::Closed(_)) => {}
}
```

### Input Path (User → PTY)

```
stdin read task → bounded_channel(100) → main loop → Arc<Mutex<Writer>> → PTY stdin
```

| Stage                          | Buffering             | Backpressure                      |
| ------------------------------ | --------------------- | --------------------------------- |
| `mpsc::channel(100)` for stdin | 100 items (~100KB)    | **Yes** — reader blocks when full |
| `ReadyManager` (watch channel) | Single bool state     | Flow control gate                 |
| `IdleWaiter` (atomic)          | Single u64 timestamp  | Polling-based gate                |
| `writer.lock().write_all()`    | Mutex + OS PTY buffer | **Yes** — blocks on mutex + OS    |

### Channel Summary

| Channel        | Type                         | Capacity  | Backpressure               |
| -------------- | ---------------------------- | --------- | -------------------------- |
| PTY output     | `unbounded_channel<String>`  | Unlimited | **None**                   |
| Stdout writer  | `channel<String>(1250)`      | ~10MB     | Soft (drop + warn on full) |
| Stdin input    | `channel<Vec<u8>>(100)`      | ~100KB    | **Yes** (blocks reader)    |
| Ready state    | `watch::channel<bool>`       | 1 value   | N/A (state, not queue)     |
| Swarm commands | `channel<SwarmCommand>(100)` | 100 items | **Yes**                    |
| Swarm events   | `channel<SwarmEvent>(100)`   | 100 items | **Yes**                    |

### Buffer Sizes

| Buffer                  | Size                           | Location                    |
| ----------------------- | ------------------------------ | --------------------------- |
| PTY read buffer         | 8KB (stack)                    | `pty_spawner.rs:159`        |
| UTF-8 partial buffer    | ≤4 bytes                       | `pty_spawner.rs` (heap Vec) |
| In-memory output buffer | ~100KB max (truncated at 50KB) | `context.rs:291`            |
| Stdout channel          | 1250 items (~10MB)             | `context.rs:105`            |
| Stdin channel           | 100 items (~100KB)             | `context.rs:119`            |
| PTY OS buffer           | ~64KB (OS-dependent)           | Kernel                      |

### What Happens Under Pressure

| Scenario                            | Behavior                                                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Fast PTY output, slow main loop** | Unbounded channel grows in heap memory. Practical bound: main loop runs every 50ms (heartbeat), so accumulation is limited. |
| **Fast PTY output, slow stdout**    | Bounded stdout channel (1250 items) fills → `try_send()` drops output and logs warning. Agent continues normally.           |
| **Stdin channel full**              | Stdin reader task blocks at `send().await`. User input accepted once main loop consumes.                                    |
| **PTY stdin buffer full**           | `writer.lock().write_all()` blocks at OS level. Natural bounded behavior.                                                   |
| **Main loop stall**                 | Unbounded channel grows. In-memory buffer capped at ~100KB with truncation.                                                 |

---

## Comparison

| Aspect                       | TypeScript                           | Rust                                        |
| ---------------------------- | ------------------------------------ | ------------------------------------------- |
| **PTY output buffering**     | Eager callback, no explicit buffer   | Thread + unbounded channel                  |
| **Output overflow handling** | Implicit (Web Streams internal)      | Explicit drop + warn at 10MB stdout channel |
| **In-memory output cap**     | None (TerminalRenderStream grows)    | ~100KB with truncation                      |
| **Input flow control**       | ReadyManager + IdleWaiter (promises) | ReadyManager + IdleWaiter (watch + atomic)  |
| **Input channel**            | ReadableStream (highWaterMark: 16)   | Bounded channel (100 items)                 |
| **PTY write error handling** | Return value ignored                 | Mutex + write_all (blocks on full)          |
| **Heartbeat interval**       | 800ms                                | 50ms                                        |
| **Force-ready timeout**      | 10s fallback                         | 10s fallback                                |
| **Output drop strategy**     | None — accumulates                   | Explicit drop + warn log                    |
| **Memory growth risk**       | Medium (TerminalRenderStream, sflow) | Low (bounded channels + truncation)         |

### Key Differences

1. **Rust is more explicit about overflow.** It uses bounded channels with defined capacities, intentional drop semantics, and now logs warnings when drops occur. TypeScript relies on implicit Web Streams behavior.

2. **Rust heartbeat is 16x faster** (50ms vs 800ms), meaning pattern matching and state transitions respond faster to output changes.

3. **Rust stdin has backpressure.** The bounded `channel(100)` blocks the stdin reader when full. TypeScript's stdinStream now has `highWaterMark: 16` for explicit memory bounds.

4. **Both have a force-ready fallback.** Both implementations force-ready after 10s if the ready pattern never matches (`context.rs:156`, `ts/index.ts` sleep(10e3)).

5. **Neither checks shell.write() return values** in the TypeScript impl. Rust uses `write_all()` which blocks until complete or errors.

---

## Known Issues

### Both Implementations

- **No end-to-end backpressure from stdout to PTY.** If the terminal/display can't keep up, old output is buffered or dropped, but the agent CLI is never throttled. This is intentional — agent operation is prioritized over output completeness.

- **Ready pattern mismatch risk.** If configured regex patterns don't match the CLI output, input gating blocks until force-ready fires after 10s in both implementations.

### TypeScript-Specific

- `shell.write()` return value never checked — writes to full PTY buffer may silently fail
- TerminalRenderStream has no explicit memory bounds
- File logging errors silently caught — no feedback on disk I/O failures

### Rust-Specific

- Unbounded PTY output channel can grow without limit if main loop stalls (mitigated by fast 50ms heartbeat)
- `ReadyManager` uses both Mutex and watch channel — potential for contention on high-frequency state checks

---

## Recent Fixes

### v1.62.0

1. **Fixed `.ready` vs `.isReady` bug (TS)** — `messaging.ts` was checking `context.nextStdout.ready` (the method reference, always truthy) instead of `context.nextStdout.isReady` (the boolean property). This meant the Enter retry logic in `sendEnter()` never executed. Fixed to use `.isReady`.

2. **Added 30s timeout to `nextStdout.wait()` (TS)** — `sendMessage()` could block indefinitely if no stdout arrived. Now uses `Promise.race` with a 30s timeout that logs a warning and continues.

3. **Added `highWaterMark: 16` to stdinStream (TS)** — The stdin `ReadableStream` had no explicit queuing strategy, relying on defaults. Now has an explicit bound of 16 chunks.

4. **Added overflow warning logging (RS)** — `stdout_tx.try_send()` was silently discarding dropped output. Now logs a `warn!` on the first drop and every 100th drop thereafter, with a running count.

---

## Recommendations

1. ~~**Add timeout to nextStdout.wait() (TS)**~~ — Done (30s timeout)
2. **Check shell.write() return (TS)** — not feasible (node-pty `write()` returns void)
3. ~~**Add overflow metrics (RS)**~~ — Done (drop counter + warn logging)
4. **Consider bounded PTY channel (RS)** — intentionally unbounded per code comments; 100KB buffer cap limits memory
5. ~~**Add force-ready fallback (RS)**~~ — Already exists at `context.rs:156` (10s timeout)
6. ~~**Add highWaterMark to sflow streams (TS)**~~ — Done (stdinStream highWaterMark: 16)
