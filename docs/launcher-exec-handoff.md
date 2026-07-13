# Launcher exec() Handoff — drop the resident bun supervisor per agent

**Status:** proposed / not yet implemented
**Goal:** keep the bun/npm distribution toolchain (`bun install -g agent-yes`) but stop
the bun launcher process from staying resident for the whole agent lifetime.
**Expected win:** ~17 MB RSS reclaimed **per agent** + faster startup. At ~46 concurrent
agents that is ~0.8 GB. It does **not** address the dominant memory cost (the `claude`
child, 120–500 MB each) — see "Non-goals".

---

## Problem

Every agent currently runs as a 3-layer chain (measured 2026-07-01, macOS arm64):

| Layer                              | Runtime | RSS        | Role                                               |
| ---------------------------------- | ------- | ---------- | -------------------------------------------------- |
| bun launcher (`dist/agent-yes.js`) | TS/bun  | **~17 MB** | resolves + spawns the rust binary, then **sleeps** |
| rust wrapper (`agent-yes`)         | Rust    | ~7 MB      | PTY supervision, the real work                     |
| `claude` child                     | node    | 120–500 MB | the actual agent                                   |

The bun launcher does genuine **one-time** work (auto-update check, tray spawn, config
resolution, rust-binary resolution/download, arg building) — but after that, in
`ts/cli.ts` (the `if (config.useRust)` block) it does:

```ts
const child = spawn(rustBinary, rustArgs, { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(/* mirror */));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
await new Promise(() => {}); // never resolves — bun stays resident here
```

So ~17 MB of bun runtime is pinned for the entire session purely to **forward two
signals and mirror an exit code**. With N agents that is N × ~17 MB of pure overhead.

## Insight

The bun/npm layer is worth keeping — it is the distribution and self-update mechanism.
What is wasteful is that it _supervises_ rather than _hands off_. On POSIX, `execvp(2)`
**replaces the current process image**: same PID, same PPID, same open fds, same env,
same cwd — but the bun heap is entirely freed and the process _becomes_ the rust binary.
`execvp` only returns on failure, which is exactly the fallback signal we want.

## Solution

Replace `spawn()+wait` with an `exec()` handoff on POSIX. Keep everything before the
handoff (resolution, update check, tray) unchanged.

### Handoff primitive (Bun, POSIX)

There is no exec-replace in the Node/Bun standard API, so call libc `execv`/`execvp`
via `bun:ffi` (no new npm dependency):

```ts
// ts/execReplace.ts (new) — POSIX only. Returns ONLY on failure.
import { dlopen, FFIType, cString, ptr } from "bun:ffi";

export function execReplace(bin: string, args: string[]): void {
  const libcPath = process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6";
  const { symbols } = dlopen(libcPath, {
    execv: { args: [FFIType.cstring, FFIType.ptr], returns: FFIType.i32 },
  });

  // Build a NULL-terminated char *argv[]. argv[0] must be the binary path.
  const argv = [bin, ...args];
  const cStrings = argv.map((s) => cString(s)); // keep refs alive until execv
  const arr = new BigInt64Array(argv.length + 1);
  cStrings.forEach((c, i) => (arr[i] = BigInt(ptr(c))));
  arr[argv.length] = 0n; // NULL terminator

  symbols.execv(cString(bin), ptr(arr)); // no return on success
  // If we reach here, execv failed (errno set) — caller falls back.
}
```

> Note: verify the exact `bun:ffi` argv marshalling on the target Bun version — the
> pointer-array packing (`BigInt64Array` vs `Uint8Array` of pointers) is the fiddly part.
> A `bun:ffi` `cc`/inline-C shim calling `execv` directly is an acceptable alternative if
> the pointer packing proves brittle.

### Wire-up in `ts/cli.ts`

```ts
if (rustBinary) {
  const { SUPPORTED_CLIS } = await import("./SUPPORTED_CLIS.ts");
  const rustArgs = buildRustArgs(process.argv, config.cli, SUPPORTED_CLIS);

  // POSIX: become the rust binary (no resident bun). Windows: keep spawn+wait.
  if (process.platform !== "win32") {
    // Pre-check so a missing binary falls back cleanly instead of erroring in FFI.
    if (existsSync(rustBinary)) {
      try {
        const { execReplace } = await import("./execReplace.ts");
        execReplace(rustBinary, rustArgs); // returns only on failure
      } catch {
        /* fall through to spawn / TS fallback */
      }
    }
    // reaching here = exec failed → fall through to the spawn path below (or TS fallback)
  }

  // Existing spawn+wait path — retained for Windows and as the exec-failure fallback.
  const child = spawn(rustBinary, rustArgs, {
    stdio: "inherit",
    env: process.env,
    cwd: process.cwd(),
  });
  // ...unchanged exit/signal mirroring...
  await new Promise(() => {});
}
```

Everything upstream (`getRustBinary()` resolution/download, update check at
`ts/cli.ts` top, tray) is untouched.

---

## Why nothing breaks (what exec preserves)

| Concern                                     | Outcome after exec()                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| `bun install -g` / npm packaging            | **Unchanged** — the JS entry is still the installed command.             |
| update check / tray / resolution            | **Unchanged** — all run in bun _before_ the handoff.                     |
| stdio                                       | Already `inherit`; fds survive exec, so the terminal stays wired.        |
| exit code                                   | rust _is_ the process now → its exit code is the real one. No mirroring. |
| SIGINT / SIGTERM                            | Delivered natively to the (now-rust) process. No forwarding needed.      |
| `AGENT_YES_PID` / subagent tree             | env survives exec → passes through unchanged.                            |
| serve/other code targeting the launcher PID | PID is preserved by exec → still hits the same process.                  |

---

## Risks

1. **Windows has no true exec-replace.** `_execvp` on Windows terminates the parent but
   uses CreateProcess semantics (new PID, different console/signal behavior). **Do not**
   attempt exec on `win32` — keep the existing `spawn()+wait`. This optimization is
   POSIX-only (which is where the fleet runs). The platform branch already exists in
   `ts/cli.ts`.

2. **Lost JS-side error fallback.** Today `child.on("error", ENOENT)` falls back to the
   TS runtime if the rust binary is missing. `execv` gives no such callback — it just
   returns −1. Mitigate by (a) `existsSync(rustBinary)` **before** exec, and (b) treating
   any return from `execReplace` as failure → fall through to the retained spawn path,
   which still has its ENOENT→TS fallback. Net: the fallback is preserved, just relocated.

3. **Flatter pid tree may confuse `ay ls` / console rendering.** Today there are two
   processes (bun parent + rust child); after exec there is one (bun PID _becomes_ rust).
   Code that assumes "launcher PID ≠ rust PID", or that walks parent/wrapper_pid for the
   subagent tree, must be re-verified. See `docs/` + the subagent-tree logic
   (`AGENT_YES_PID`, `pids.jsonl` `wrapper_pid`). **Low risk** (exec keeps PID/PPID) but
   **must be tested** — a stale assumption here silently flattens or mis-nests the tree.

4. **`bun:ffi` argv marshalling is easy to get subtly wrong.** A mispacked `char**` or a
   GC'd `cString` before `execv` runs = crash or exec of garbage. Keep refs alive until
   the call; unit/inspect the pointer array. Consider a `bun:ffi` inline-C shim if the
   raw pointer packing is fragile on the target Bun version.

5. **libc path portability.** `libSystem.B.dylib` (macOS) vs `libc.so.6` (glibc Linux)
   vs musl (`libc.so` on Alpine — relevant for `swarm-in-docker`). Resolve the correct
   libc per platform, or dlopen the already-loaded symbol namespace if Bun supports it.
   Test inside the Docker swarm image, not just on the host.

6. **Post-exec cleanup that used to run in the bun parent.** Audit whether anything
   relied on the bun parent outliving the child (temp-file cleanup, pid deregistration,
   `on("exit")` bookkeeping). The rust wrapper already owns pid_store lifecycle, so this
   is expected to be nothing — but confirm before shipping.

---

## Non-goals

- **The `claude` child footprint (120–500 MB) is untouched.** It is node/claude itself;
  no change to agent-yes's launcher can shrink it. The real memory lever remains the
  **number of concurrent agents**, not the wrapper runtime. This change reclaims only the
  bun supervisor overhead (~17 MB/agent).
- Not changing the rust wrapper (already ~7 MB, near-minimal).
- Not changing distribution: `bun install -g agent-yes` / npm stays exactly as-is.

---

## Verification plan (before shipping)

Ship as its own PR (this path is on **every** `ay`/`cy` invocation — a regression breaks
all agents). Verify on macOS + Linux (host and Docker swarm):

1. **Exit-code transparency** — run a CLI that exits with a known non-zero code through
   `ay`; assert the shell sees the same code (rust's, un-mirrored).
2. **Signal transparency** — SIGINT and SIGTERM to `ay` reach the agent and terminate it
   cleanly; no orphaned rust/claude.
3. **Subagent tree health** — `ay ls` and the web console render the parent/child agent
   tree correctly after the pid-tree flattening (spawn a nested agent, confirm nesting).
4. **Fallback paths** — (a) missing rust binary → falls back to TS runtime; (b) exec
   failure mid-call → falls back to spawn/TS.
5. **RSS delta** — confirm the bun launcher process is gone (`ps` shows only rust+claude)
   and measure the ~17 MB/agent reclamation.
6. **Windows** — confirm win32 still uses spawn+wait unchanged (no exec attempted).

Use a fake CLI driven via the fifo (see the panic-gesture live test in
`rs/src/context.rs` history / PR #145) for deterministic exit-code and signal checks.
