import { mkdir, readFile, rm, writeFile, rename } from "fs/promises";
import path from "path";
import { agentYesHome } from "./agentYesHome.ts";
import { isTransientLockMkdirError } from "./notifyStore.ts";

/**
 * Singleton lock for the WebRTC host role: one `ay serve` host per
 * ~/.agent-yes. Two hosts sharing the persisted room (~/.agent-yes/.share-room)
 * fight over every viewer connection — the exact outage seen live: an orphaned
 * `ay serve --webrtc` from a previous manager era plus a manual run left the
 * managed daemon crash-looping (12 watchdog restarts) and the share link
 * unloadable. The lock makes the loser fail FAST with a pointer to the owner
 * instead of silently contending.
 *
 * mkdir-based (atomic on every platform), owner JSON alongside, heartbeat
 * refresh while held. A stale owner — dead pid, or a heartbeat older than
 * SERVE_LOCK_STALE_MS (a SIGKILLed host can't clean up) — is stolen, so a
 * crashed host never wedges the next start.
 */

export const SERVE_LOCK_STALE_MS = 20_000;
export const SERVE_LOCK_BEAT_MS = 5_000;
// Riding out a manager roll-forward: stop-old/start-new overlap briefly, so a
// new host retries for a grace window before declaring the lock busy.
export const SERVE_LOCK_GRACE_MS = 12_000;

export type ServeLockOwner = { pid: number; started_at: number; beat_at: number };

export type ServeLockResult =
  | { ok: true; release: () => Promise<void> }
  | { ok: false; owner: ServeLockOwner | null };

function lockDir(): string {
  return path.join(agentYesHome(), "webrtc-host.lock");
}
function ownerPath(): string {
  return path.join(lockDir(), "owner.json");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = alive but not ours; only ESRCH means gone.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readOwner(): Promise<ServeLockOwner | null> {
  try {
    const o = JSON.parse(await readFile(ownerPath(), "utf-8")) as ServeLockOwner;
    return typeof o?.pid === "number" ? o : null;
  } catch {
    return null;
  }
}

/** Pure staleness decision, exported for tests. */
export function isOwnerStale(
  owner: ServeLockOwner | null,
  now: number,
  alive: (pid: number) => boolean,
  staleMs = SERVE_LOCK_STALE_MS,
): boolean {
  if (!owner) return true; // torn/absent owner: mkdir won but write died
  if (!alive(owner.pid)) return true;
  return now - owner.beat_at > staleMs;
}

// Atomic owner stamp (temp + rename) so a concurrent reader never parses a
// torn file as "no owner" while we in fact hold the lock.
async function stampOwner(startedAt: number): Promise<boolean> {
  const tmp = `${ownerPath()}.${process.pid}.tmp`;
  try {
    await writeFile(
      tmp,
      JSON.stringify({ pid: process.pid, started_at: startedAt, beat_at: Date.now() }),
    );
    await rename(tmp, ownerPath());
    return true;
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
    return false;
  }
}

/**
 * Acquire the host lock, retrying for up to `graceMs`. Returns fast on a live
 * owner once the grace expires (never blocks a daemon boot forever). With
 * `takeover`, a live owner is SIGTERM'd (then SIGKILL'd) and the lock stolen.
 */
export async function acquireWebrtcHostLock(opts?: {
  takeover?: boolean;
  graceMs?: number;
  staleMs?: number;
  /** Heartbeat cadence override — tests only. */
  beatMs?: number;
  /** SIGTERM→SIGKILL escalation wait for --takeover — tests only. */
  takeoverWaitMs?: number;
}): Promise<ServeLockResult> {
  const graceMs = opts?.graceMs ?? SERVE_LOCK_GRACE_MS;
  const staleMs = opts?.staleMs ?? SERVE_LOCK_STALE_MS;
  const beatMs = opts?.beatMs ?? SERVE_LOCK_BEAT_MS;
  const startedAt = Date.now();
  const deadline = startedAt + graceMs;
  let tookOver = false;
  for (;;) {
    try {
      await mkdir(lockDir(), { recursive: false });
      if (!(await stampOwner(startedAt))) {
        await rm(lockDir(), { recursive: true, force: true }).catch(() => {});
        return { ok: false, owner: null };
      }
      // Heartbeat while held; stops itself if a thief replaced our owner file.
      const beat = setInterval(() => {
        void (async () => {
          const o = await readOwner();
          if (o?.pid !== process.pid) {
            clearInterval(beat);
            return;
          }
          await stampOwner(startedAt);
        })();
      }, beatMs);
      if (typeof beat.unref === "function") beat.unref();
      return {
        ok: true,
        release: async () => {
          clearInterval(beat);
          if ((await readOwner())?.pid === process.pid)
            await rm(lockDir(), { recursive: true, force: true }).catch(() => {});
        },
      };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!isTransientLockMkdirError(code)) throw e;
      if (code !== "EEXIST") {
        // win32 mkdir-vs-rm race: dir mid-delete, just retry.
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      const owner = await readOwner();
      if (isOwnerStale(owner, Date.now(), pidAlive, staleMs)) {
        await rm(lockDir(), { recursive: true, force: true }).catch(() => {});
        continue; // re-prove via mkdir — two stealers can't both win
      }
      if (opts?.takeover && owner && !tookOver) {
        tookOver = true; // one shot: never kill a second, newer owner
        try {
          process.kill(owner.pid, "SIGTERM");
        } catch {
          /* already gone */
        }
        // Give it a moment to shut down cleanly (it releases the lock), then
        // escalate; the loop's stale check mops up whatever remains.
        await new Promise((r) => setTimeout(r, opts?.takeoverWaitMs ?? 2_000));
        if (pidAlive(owner.pid)) {
          try {
            process.kill(owner.pid, "SIGKILL");
          } catch {
            /* gone */
          }
        }
        await rm(lockDir(), { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) return { ok: false, owner };
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
