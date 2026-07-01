/**
 * Spawn admission control — keep an unbounded fan-out of agents from exhausting
 * host RAM and tripping the kernel OOM-killer (which, on a box with no cgroup
 * memory limit, hangs the whole machine). Two opt-in limits:
 *   - {@link getMaxAgents}  — max concurrently-live agents
 *   - {@link getMinFreeMb}  — minimum free memory before admitting a spawn
 *
 * Two entry points share one instantaneous check ({@link spawnRejectionReason}):
 *   - the `ay serve` daemon HARD-REJECTS (`/api/spawn` → 429) so the caller retries;
 *   - the CLI path BLOCKS-AND-WAITS ({@link waitForSpawnCapacity}) with φ-backoff,
 *     failing open after a timeout so recursive `ay <cli>` spawns get spaced out
 *     (the actual cause of the burst storms) without ever deadlocking a workflow.
 */
import { readFile } from "fs/promises";
import { readGlobalPids } from "./globalPidIndex.ts";
import { getMaxAgents, getMinFreeMb, getSpawnWaitMs } from "./workspaceConfig.ts";

/**
 * System available memory in MB. Prefers Linux `/proc/meminfo` `MemAvailable`
 * (the kernel's own estimate of what's reclaimable without swapping — far more
 * accurate than free RAM), falling back to `os.freemem()` on other platforms or
 * if the file can't be parsed. Returns null when nothing usable is available.
 */
export async function memAvailableMb(): Promise<number | null> {
  try {
    const txt = await readFile("/proc/meminfo", "utf-8");
    const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(txt);
    if (m) return Math.floor(Number(m[1]) / 1024);
  } catch {
    /* not Linux / unreadable — fall through */
  }
  try {
    const { freemem } = await import("os");
    return Math.floor(freemem() / (1024 * 1024));
  } catch {
    return null;
  }
}

/** True when at least one spawn limit is configured (else the gate is a no-op). */
export function spawnGateEnabled(): boolean {
  return getMaxAgents() !== undefined || getMinFreeMb() !== undefined;
}

/**
 * Instantaneous capacity check. Returns a human-readable reason string when a
 * new spawn should be held back (cap reached / memory too low), or null when
 * there's capacity. Both limits are opt-in — unset means no check.
 *
 * NOTE — the `maxAgents` count is BEST-EFFORT, not a hard barrier: the check is
 * non-atomic (check here → register in `pids.jsonl` later, in another process),
 * so a simultaneous burst can briefly overshoot the cap before the new wrappers
 * appear in the live count. That's acceptable because (a) the CLI path's
 * φ-backoff desynchronizes retries, spreading a burst out, and (b) `minFreeMb`
 * is the HARD OOM guard — it's re-evaluated against live `/proc/meminfo` on every
 * attempt, so once RAM actually drops, further spawns are held regardless of the
 * count. Exact admission would need a cross-process reservation+lock (a TTL'd
 * reservation file); deliberately deferred to avoid stale reservations wedging
 * spawns, which would be worse than a transient overshoot.
 */
export async function spawnRejectionReason(): Promise<string | null> {
  const maxAgents = getMaxAgents();
  if (maxAgents !== undefined) {
    // Live agents already running (this wrapper hasn't registered itself yet),
    // so "live >= cap" admits exactly `maxAgents` concurrent agents.
    const live = (await readGlobalPids({ liveOnly: true })).length;
    if (live >= maxAgents)
      // Phrased for the end user who clicked "Spawn" (the console shows this
      // string verbatim), with a host-admin hint appended in parentheses.
      return `too many agents running (${live}/${maxAgents}) — this agent wasn't started. Please wait for one to finish and try again. (host: raise "maxAgents" in ~/.agent-yes/config.json or AGENT_YES_MAX_AGENTS)`;
  }
  const minFreeMb = getMinFreeMb();
  if (minFreeMb !== undefined) {
    const avail = await memAvailableMb();
    if (avail !== null && avail < minFreeMb)
      return `the host is low on memory (${avail}MB free, needs ${minFreeMb}MB) — this agent wasn't started, to avoid crashing the machine. Please try again in a moment. (host: adjust "minFreeMb" in ~/.agent-yes/config.json or AGENT_YES_MIN_FREE_MB)`;
  }
  return null;
}

const PHI = 1.618; // golden-ratio backoff base (snomiao global pref)
const BACKOFF_CAP_MS = 60_000;
const BACKOFF_BASE_MS = 1_000;

/**
 * Block until there's spawn capacity, polling with φ-backoff (1s × φⁿ, capped at
 * 60s — there is no OS event for "memory freed", so polling is unavoidable here).
 * Fails open after {@link getSpawnWaitMs} ms (default 10 min): on timeout it logs
 * and proceeds, so a set of mutually-waiting recursive spawns can never deadlock
 * permanently. A no-op (returns immediately) when no limit is configured, so it
 * adds ~zero overhead to the spawn hot path for users who haven't opted in.
 *
 * `sleep`/`now` are injectable for tests. `onWait` fires once per backoff cycle.
 */
export async function waitForSpawnCapacity(opts?: {
  maxWaitMs?: number;
  onWait?: (reason: string, waitedMs: number) => void;
  onProceedAnyway?: (reason: string, waitedMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<void> {
  if (!spawnGateEnabled()) return; // fast path: nothing configured
  const maxWaitMs = opts?.maxWaitMs ?? getSpawnWaitMs();
  // Monotonic clock for the deadline — `Date.now()` can step backward (NTP /
  // suspend) and stretch the fail-open wait far past `maxWaitMs`.
  const now = opts?.now ?? (() => performance.now());
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = now();
  let delay = BACKOFF_BASE_MS;
  for (;;) {
    const reason = await spawnRejectionReason();
    if (!reason) return; // capacity available — admit
    const waited = now() - start;
    if (waited >= maxWaitMs) {
      opts?.onProceedAnyway?.(reason, waited);
      return; // fail open — never deadlock a workflow
    }
    opts?.onWait?.(reason, waited);
    // Don't oversleep past the deadline.
    await sleep(Math.min(delay, BACKOFF_CAP_MS, maxWaitMs - waited));
    delay = Math.min(delay * PHI, BACKOFF_CAP_MS);
  }
}
