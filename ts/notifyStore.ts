/**
 * Filesystem side of the notification inbox — the impure half of the pure
 * `notifyInbox.ts` path/serialization core. Handles the locked append (so
 * concurrent daemon ticks / future writers never interleave a seq), inbox and
 * cursor reads/writes, and retention GC.
 *
 * The lock is a mkdir-based advisory lock (same primitive `pidStore` uses), held
 * only for the microseconds of a read-counter → append-line → write-counter, so
 * contention is negligible even with many parents.
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile, appendFile } from "fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "path";
import { logger } from "./logger.ts";
import {
  type NotifyEvent,
  WATCHER_TTL_MS,
  cursorDir,
  cursorPath,
  inboxDir,
  inboxPath,
  maxSeq,
  nextSeq,
  parseCursor,
  parseInboxText,
  rotateKeep,
  seqPath,
  serializeCursor,
  serializeEvent,
  watcherPath,
  watchersDir,
} from "./notifyInbox.ts";

/** Stable local host id — the pid namespace is per-host. */
export function hostId(): string {
  return os.hostname() || "localhost";
}

// Local liveness probe (kill(pid,0)) — kept here so notifyStore doesn't import
// subcommands (which imports notifyStore: a cycle). Mirrors isPidAlive.
function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, not ours
  }
}

/**
 * Pure steal decision for a per-inbox lock (extracted so it's unit-testable):
 * steal the lock ONLY when its holder is provably gone (torn/missing owner on a
 * lock that has EXISTED longer than the grace, or a dead pid) or its heartbeat is
 * stale — NEVER merely because the contender has waited a while.
 *
 * Crucially, the torn-owner grace is measured from the LOCK INSTANCE's age
 * (`lockAgeMs` = now − lockDir mtime), NOT from how long the contender has been
 * waiting. Otherwise a contender that waited out one holder could instantly steal
 * the NEXT holder's freshly-created lock during its mkdir→write-owner window
 * (torn but brand-new) — letting two writers into the critical section.
 */
export function shouldStealLock(
  ownerRaw: string,
  now: number,
  opts: {
    staleMs: number;
    /** Age of THIS lock instance (now − lockDir mtime). Gates the torn grace. */
    lockAgeMs: number;
    selfPid: number;
    isAlive: (p: number) => boolean;
    /** Grace for a JUST-created lock whose owner file isn't written yet. */
    graceMs?: number;
  },
): boolean {
  const graceMs = opts.graceMs ?? 1000;
  let ownerPid = 0;
  let ownerTs = 0;
  let parsed = false;
  try {
    const o = JSON.parse(ownerRaw) as { pid: number; ts: number };
    ownerPid = o?.pid ?? 0;
    ownerTs = o?.ts ?? 0;
    parsed = true;
  } catch {
    /* torn / not-yet-written owner */
  }
  // An empty/torn owner (or one with no heartbeat ts yet) is the mkdir→write-owner
  // window of a holder mid-acquire — NOT proof of a dead holder. Only steal it
  // once THIS lock instance has existed torn longer than the grace (a real crash
  // in that window), so we can never rob a lock that was just legitimately created
  // (which would let two writers into the critical section and duplicate a seq).
  if (!parsed || ownerPid <= 0 || ownerTs <= 0) return opts.lockAgeMs > graceMs;
  // Steal ONLY on positive evidence the holder is gone: its pid is dead, or its
  // heartbeat went stale. A LIVE holder refreshes its heartbeat for the whole
  // time it holds the lock (see acquireLock), so a long-but-legitimate critical
  // section (a big GC rewrite) is never robbed — and a wedged holder stops
  // refreshing, so staleMs still reclaims it. Wall-clock wait time ALONE never
  // steals (no hardMs backstop): that was the only path left that could rob a
  // live holder.
  const holderDead = ownerPid !== opts.selfPid && !opts.isAlive(ownerPid);
  const holderStale = now - ownerTs > opts.staleMs;
  return holderDead || holderStale;
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true }).catch(() => {});
}

/**
 * Atomically overwrite a single file (temp + rename) so a concurrent reader never
 * observes a torn/partial write — the sweep invariant for every single-file
 * mutation (cursor, watcher heartbeat, lock owner). Returns whether it landed.
 */
async function atomicWrite(file: string, data: string): Promise<boolean> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
    return true;
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
    return false;
  }
}

/**
 * Acquire a per-inbox lock; returns a release fn. Ownership is proven ONLY by a
 * successful `mkdir(recursive:false)` (atomic exclusive create), and stealing is
 * driven by HOLDER LIVENESS, not elapsed wait time: the holder writes an
 * `owner` file ({pid, ts}) on acquire AND heartbeats its ts for the whole time
 * it holds the lock, so a contender steals ONLY when that holder is dead or its
 * heartbeat is stale. A live holder whose critical section legitimately runs long
 * (a big GC rewrite, a slow disk) is never robbed — its heartbeat stays fresh;
 * and a wedged holder stops heartbeating, so staleMs still reclaims it. There is
 * deliberately NO wall-clock backstop: elapsed wait time alone never steals, so a
 * live holder is inviolable.
 */
export async function acquireLock(
  lockDir: string,
  staleMs = 30_000,
): Promise<() => Promise<void>> {
  const ownerFile = path.join(lockDir, "owner");
  // A fencing token unique to THIS acquisition. Everything we do to the lock is
  // gated on the owner file still carrying our token — so if we were stale-stolen
  // mid-critical-section and the lock re-created by another writer, we neither
  // overwrite their owner nor delete their lock. Classic fencing.
  const token = randomUUID();
  const readOwnerToken = async (): Promise<string | null> => {
    try {
      return (JSON.parse(await readFile(ownerFile, "utf8")) as { token?: string }).token ?? null;
    } catch {
      return null;
    }
  };
  // ATOMIC owner write (temp + rename): a reader never observes a torn/partial
  // owner mid-write, so `readOwnerToken()===null` reliably means "no owner file"
  // (a NEW instance mid-acquire), never "our own write in progress". That in turn
  // lets the heartbeat safely stop on a null read without self-eviction.
  const stampOwner = async (): Promise<boolean> => {
    const tmp = `${ownerFile}.${token}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify({ pid: process.pid, ts: Date.now(), token }));
      await rename(tmp, ownerFile);
      return true;
    } catch {
      await rm(tmp, { force: true }).catch(() => {});
      return false;
    }
  };
  const lockAgeMs = async (): Promise<number> => {
    const m = await stat(lockDir)
      .then((s) => s.mtimeMs)
      .catch(() => Date.now());
    return Date.now() - m;
  };
  for (;;) {
    try {
      await mkdir(lockDir, { recursive: false });
      // If we can't write our owner file, we do NOT own the lock — a later
      // contender would see a torn owner, steal past the grace, and enter the
      // critical section alongside us. Drop the lock dir and retry.
      if (!(await stampOwner())) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => {});
        await new Promise((r) => setTimeout(r, 15));
        continue;
      }
      // Heartbeat the owner ts while we hold the lock, so a LONG critical section
      // (a big gcInboxes rewrite) never crosses staleMs and gets stolen. Refresh
      // ONLY while the owner still carries OUR token: any other value — a
      // different token (superseded) OR null/absent (a new instance's mkdir→write
      // window) — means we no longer own it, so we stop rather than clobber an
      // unknown/absent owner. Atomic writes above mean a null read is never just
      // our own write in flight. Refresh well inside staleMs; cleared on release.
      const beat = setInterval(() => {
        void (async () => {
          if ((await readOwnerToken()) !== token) {
            clearInterval(beat);
            return;
          }
          await stampOwner();
        })();
      }, Math.max(500, Math.floor(staleMs / 3)));
      if (typeof beat.unref === "function") beat.unref();
      return async () => {
        clearInterval(beat);
        // Release ONLY if we still hold it — never delete a lock another writer
        // now owns (which would open the critical section to a third writer).
        if ((await readOwnerToken()) === token)
          await rm(lockDir, { recursive: true, force: true }).catch(() => {});
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const raw = await readFile(ownerFile, "utf8").catch(() => "");
      if (
        shouldStealLock(raw, Date.now(), {
          staleMs,
          lockAgeMs: await lockAgeMs(),
          selfPid: process.pid,
          isAlive: pidAlive,
        })
      ) {
        // Steal, then loop back — the next mkdir(recursive:false) re-proves
        // ownership, so two contenders can't both enter the critical section.
        await rm(lockDir, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  }
}

/**
 * Append one event to a parent's inbox under lock, allocating the next seq. The
 * caller passes the event WITHOUT seq (we stamp it). Returns the stamped seq.
 */
export async function appendEvent(
  parentPid: number,
  ev: Omit<NotifyEvent, "seq">,
): Promise<number> {
  const host = ev.host;
  const dir = inboxDir(host);
  await ensureDir(dir);
  const lock = path.join(dir, `${parentPid}.lock`);
  const release = await acquireLock(lock);
  try {
    // TRUST the sidecar counter — it is written under this same lock on every
    // append, so it is always the authoritative last-allocated seq (and it stays
    // valid across a GC rewrite, whose kept seqs are all <= the counter). Only
    // when the counter is missing/corrupt do we fall back to an O(file) scan to
    // self-heal. This keeps the hot path — and thus the lock-hold window — O(1),
    // which is what makes a long steal window (C1) a non-issue.
    let last = 0;
    const counterRaw = await readFile(seqPath(host, parentPid), "utf8").catch(() => "");
    const parsed = parseInt(counterRaw.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      last = parsed;
    } else {
      const existing = parseInboxText(
        await readFile(inboxPath(host, parentPid), "utf8").catch(() => ""),
      );
      last = maxSeq(existing);
    }
    const seq = nextSeq(last);
    // RESERVE the seq before writing the line: update the counter FIRST, then
    // append. If a crash lands between the two, we're left with a reserved-but-
    // unused seq (a harmless GAP) — never a REUSED seq. That ordering matters
    // because the cursor is seq-based: a duplicated seq would let an acked batch
    // silently skip a later, distinct notification. Gap OK, dup NOT ok.
    const full: NotifyEvent = { ...ev, seq };
    await writeFile(seqPath(host, parentPid), String(seq));
    await appendFile(inboxPath(host, parentPid), serializeEvent(full) + "\n");
    return seq;
  } finally {
    await release();
  }
}

/** Read + parse a parent's inbox (empty array when none). */
export async function readInbox(host: string, parentPid: number): Promise<NotifyEvent[]> {
  const text = await readFile(inboxPath(host, parentPid), "utf8").catch(() => "");
  return parseInboxText(text);
}

/** All parent pids that currently have an inbox on this host. */
export async function listInboxParents(host: string): Promise<number[]> {
  const dir = inboxDir(host);
  const names = await readdir(dir).catch(() => [] as string[]);
  const pids: number[] = [];
  for (const n of names) {
    const m = /^(\d+)\.ndjson$/.exec(n);
    if (m) pids.push(parseInt(m[1]!, 10));
  }
  return pids;
}

export async function getCursor(host: string, parentPid: number, consumer = "parent"): Promise<number> {
  const text = await readFile(cursorPath(host, parentPid, consumer), "utf8").catch(() => null);
  return parseCursor(text).seq;
}

/**
 * Minimum cursor across ALL consumers of a parent inbox — the watermark below
 * which rotation may evict events (nothing above it has been acked by every
 * reader). Returns 0 when there are no consumers — which PROTECTS EVERYTHING:
 * with a 0 watermark, `rotateKeep` treats every event as unacked and evicts
 * nothing (an inbox nobody reads is never trimmed).
 */
export async function minConsumerCursor(host: string, parentPid: number): Promise<number> {
  const names = await readdir(cursorDir(host, parentPid)).catch(() => [] as string[]);
  const cursors = names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
  if (cursors.length === 0) return 0;
  let min = Infinity;
  for (const c of cursors) min = Math.min(min, await getCursor(host, parentPid, c));
  return Number.isFinite(min) ? min : 0;
}

export async function setCursor(
  host: string,
  parentPid: number,
  seq: number,
  consumer = "parent",
): Promise<void> {
  const p = cursorPath(host, parentPid, consumer);
  await ensureDir(path.dirname(p));
  await atomicWrite(p, serializeCursor(seq));
}

/**
 * Retention: delete inboxes (+ their seq counter + cursors) for parents that are
 * both dead and unreferenced by any live child. `capBytes` also rotates a live
 * inbox that has grown past the cap, keeping the newest events.
 */
export async function gcInboxes(
  host: string,
  livePids: Set<number>,
  liveChildParentPids: Set<number>,
  capBytes = 10 * 1024 * 1024,
): Promise<void> {
  const parents = await listInboxParents(host);
  for (const p of parents) {
    // BOTH the delete and the rotation mutate the inbox/.seq/cursor, so BOTH run
    // under the same per-inbox lock `appendEvent` takes — a concurrent append can
    // never be lost to a mid-flight delete or rotation.
    const lock = path.join(inboxDir(host), `${p}.lock`);
    const release = await acquireLock(lock);
    try {
      if (!livePids.has(p) && !liveChildParentPids.has(p)) {
        await rm(inboxPath(host, p), { force: true }).catch(() => {});
        await rm(seqPath(host, p), { force: true }).catch(() => {});
        // Sanitized cursor dir (matches cursorPath), not a raw host join.
        await rm(cursorDir(host, p), { recursive: true, force: true }).catch(() => {});
        continue;
      }
      // Live inbox — rotate if oversized, but NEVER evict an event above the min
      // consumer cursor (unacked): at-least-once must survive rotation.
      const size = await stat(inboxPath(host, p))
        .then((s) => s.size)
        .catch(() => 0);
      if (size <= capBytes) continue;
      const events = await readInbox(host, p);
      const protectAboveSeq = await minConsumerCursor(host, p);
      const kept = rotateKeep(events, capBytes, protectAboveSeq);
      if (kept.length < events.length) {
        await writeFile(inboxPath(host, p), kept.map(serializeEvent).join("\n") + "\n");
      } else {
        // Oversize but nothing was trimmable — every event is unacked (min cursor
        // at/below the oldest). `capBytes` is a SOFT cap here (we never drop an
        // unacked edge), so surface the unbounded growth rather than silently
        // exceeding it. A parent that never acks is the usual cause.
        logger.warn(
          `[notify] inbox for parent ${p} is ${size} bytes (> soft cap ${capBytes}) but all events are unacked — cursor not advancing?`,
        );
      }
    } finally {
      await release();
    }
  }
}

// ---------------------------------------------------------------------------
// Watcher registry — the set of parents currently running `ay notify watch`.
// The daemon scopes its work to these parents (so an unrelated agent's children
// never get an inbox) and stays alive while any watcher is live; a watcher
// refreshes its heartbeat every poll and removes it on exit.
// ---------------------------------------------------------------------------

/** Register / refresh this parent's watch heartbeat (atomically, so a concurrent
 * liveWatchers never reads a torn file and transiently drops the watcher). */
export async function heartbeatWatcher(parentPid: number, startedAt: number): Promise<void> {
  await ensureDir(watchersDir());
  await atomicWrite(
    watcherPath(parentPid),
    JSON.stringify({ pid: parentPid, started_at: startedAt, ts: Date.now() }),
  );
}

/** Remove this parent's watch heartbeat (on watch exit). */
export async function clearWatcher(parentPid: number): Promise<void> {
  await rm(watcherPath(parentPid), { force: true }).catch(() => {});
}

/**
 * Live watchers as a map of parent pid → the parent's own `started_at` (its
 * authoritative self-reported start time, so the daemon never has to guess it
 * from the registry and stamp a 0). A watcher counts as live ONLY if its
 * heartbeat is fresh AND its process is actually alive — so a crashed `watch`
 * whose heartbeat lingers for the TTL doesn't keep the daemon writing to a dead
 * parent's inbox (which would violate "nothing happens unless you watch"). A
 * heartbeat with a missing/non-positive `started_at` is treated as NOT live: the
 * daemon's cross-session scope guard keys off a positive parent start time, so a
 * 0 would defeat it — fail closed.
 */
export async function liveWatchers(now = Date.now()): Promise<Map<number, number>> {
  const names = await readdir(watchersDir()).catch(() => [] as string[]);
  const live = new Map<number, number>();
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const raw = await readFile(path.join(watchersDir(), n), "utf8").catch(() => "");
    try {
      const o = JSON.parse(raw) as { pid: number; started_at?: number; ts: number };
      if (
        typeof o?.pid === "number" &&
        typeof o?.started_at === "number" &&
        o.started_at > 0 &&
        typeof o?.ts === "number" &&
        now - o.ts <= WATCHER_TTL_MS &&
        pidAlive(o.pid)
      ) {
        live.set(o.pid, o.started_at);
      }
    } catch {
      /* skip torn heartbeat */
    }
  }
  return live;
}
