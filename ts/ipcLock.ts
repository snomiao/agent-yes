/**
 * Cross-process mutual exclusion for writing to ONE agent's stdin.
 *
 * What this guarantees is ATOMICITY, not ordering. Two independent senders
 * (two console viewers, an `ay send` racing a viewer, two `ay` processes) have
 * no defined arrival order at the host, and nothing here invents one —
 * per-client ordering is the browser's single-in-flight send queue
 * (`createInputSender` in lab/ui/console-logic.js). What this prevents is the
 * two of them SPLICING into each other:
 *
 *   - `writeToIpc` does not write a payload in one syscall. A FIFO's kernel
 *     buffer is small (~8KB), so it loops on EAGAIN/partial writes while the
 *     agent drains its stdin. POSIX only promises atomicity up to PIPE_BUF
 *     (512 bytes on macOS), so two concurrent writers interleave BYTES in the
 *     middle of each other's payloads — not messages arriving in a surprising
 *     order, but one message cut in half by another.
 *   - Several input actions are inherently multi-write: `ay send` writes the
 *     body, waits ~200ms for the CLI's paste handling to settle, then writes
 *     the Enter. `ay key` paces a key sequence 40ms apart. `ay stop` writes a
 *     graceful command, Enter, then Ctrl-C twice. Every gap in those is a
 *     window where another writer's bytes can land mid-transaction — which is
 *     how a keystroke ends up fused into the middle of a sent message, or a
 *     menu navigation gets a stray character.
 *
 * So the unit protected here is the TRANSACTION, not the write: callers wrap
 * a whole logical action, and `writeToIpc` itself stays lock-free (and thus
 * non-reentrant by construction).
 *
 * FAIL-OPEN is deliberate. Making input delivery depend on acquiring a lock
 * would add a brand-new way for an agent to become unreachable, which is worse
 * than the splicing this fixes. If the lock cannot be acquired within the
 * budget, the transaction proceeds unprotected with a warning — exactly the
 * behavior that existed before this module, so this can only improve on it.
 */

import path from "path";
import { mkdir } from "fs/promises";
import { lock } from "proper-lockfile";
import { agentYesHome } from "./agentYesHome.ts";

/**
 * How long a legitimate holder may hold before we give up waiting.
 *
 * Derived, not picked: one `writeToIpc` can legitimately take up to
 * `IPC_WRITE_TIMEOUT_MS` (10s) when the agent's stdin is backed up — and that
 * is precisely when splicing is most likely, so a short budget would abandon
 * the guarantee in the one case that needs it. A wait this long only ever
 * materialises against an agent that is already not draining, where the
 * waiter's own write would be hanging anyway. Crashed holders are handled by
 * `stale` below, not by this budget.
 */
const ACQUIRE_BUDGET_MS = 12_000;

/**
 * When to steal a lock as abandoned. Must exceed the longest LEGITIMATE hold,
 * or a slow-but-alive sender gets its lock stolen mid-transaction — which
 * would reintroduce exactly the splice this module prevents. The worst legal
 * case is `ay send` against a wedged reader: two 10s writes plus the 200ms
 * settle gap.
 */
const STALE_MS = 30_000;

const RETRY_MS = 15;

/**
 * Targets this process currently holds. `proper-lockfile` is not reentrant: a
 * nested acquire from the same process on the same target would block until
 * the budget expired, wedging input for 12s. Nesting is not expected today,
 * but the cost of being wrong is "this agent accepts no input", so the guard
 * is cheaper than the audit.
 */
const heldByThisProcess = new Set<number>();

/** Lock target for an agent's stdin, keyed by pid.
 *
 * Under `$AGENT_YES_HOME`, NOT beside the FIFO: on Windows the "FIFO" is a
 * named pipe (`\\.\pipe\…`), which has no containing directory to put a
 * sibling lockfile in. Keying by pid also stays stable if the fifo path
 * changes shape between runtimes.
 */
export function ipcLockTarget(pid: number): string {
  return path.join(agentYesHome(), "locks", `ipc-${pid}`);
}

/**
 * Run `fn` with exclusive access to `pid`'s stdin across processes.
 *
 * `onFallback` is called (once) if the lock could not be acquired and `fn` is
 * about to run unprotected — callers use it to warn. `fn`'s own errors
 * propagate unchanged, and the lock is always released.
 */
export async function withIpcLock<T>(
  pid: number,
  fn: () => Promise<T>,
  onFallback?: (reason: string) => void,
): Promise<T> {
  if (heldByThisProcess.has(pid)) return fn();

  let release: (() => Promise<void>) | undefined;
  const target = ipcLockTarget(pid);
  try {
    await mkdir(path.dirname(target), { recursive: true });
    release = await lock(target, {
      lockfilePath: `${target}.lock`,
      // The target is a name, not a file we create — nothing ever writes to
      // it, so it never exists and realpath resolution would fail on it.
      realpath: false,
      stale: STALE_MS,
      retries: {
        retries: Math.ceil(ACQUIRE_BUDGET_MS / RETRY_MS),
        minTimeout: RETRY_MS,
        maxTimeout: RETRY_MS,
      },
    });
  } catch (err) {
    onFallback?.(err instanceof Error ? err.message : String(err));
    return fn();
  }

  heldByThisProcess.add(pid);
  try {
    return await fn();
  } finally {
    heldByThisProcess.delete(pid);
    // Releasing can fail if the lock was stolen as stale (a transaction that
    // outran STALE_MS). Nothing useful to do about it here, and throwing would
    // mask the outcome of `fn`, which already succeeded.
    await release().catch(() => {});
  }
}
