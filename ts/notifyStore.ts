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

import { mkdir, readFile, readdir, rm, stat, writeFile, appendFile } from "fs/promises";
import os from "node:os";
import path from "path";
import {
  type NotifyEvent,
  WATCHER_TTL_MS,
  cursorDir,
  cursorPath,
  inboxDir,
  inboxPath,
  liveWatcherPids,
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
 * steal the lock ONLY when its holder is provably gone (torn/missing owner, or a
 * dead pid) or its heartbeat is stale — NEVER merely because we've waited a
 * while, so a live holder mid-critical-section keeps its lock. `elapsed > hardMs`
 * is a last-resort backstop against a wedged-but-"alive" holder.
 */
export function shouldStealLock(
  ownerRaw: string,
  now: number,
  opts: {
    staleMs: number;
    hardMs: number;
    elapsed: number;
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
  // An empty/torn owner is the mkdir→writeFile window of a holder mid-acquire —
  // NOT proof of a dead holder. Only steal it after a short grace, so we can't
  // rob a lock that was just legitimately created (which would let two writers
  // into the critical section and duplicate a seq). The hardMs backstop still
  // reclaims a holder that crashed exactly in that window.
  if (!parsed || ownerPid <= 0) return opts.elapsed > graceMs;
  const holderDead = ownerPid !== opts.selfPid && !opts.isAlive(ownerPid);
  const holderStale = ownerTs > 0 && now - ownerTs > opts.staleMs;
  return holderDead || holderStale || opts.elapsed > opts.hardMs;
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true }).catch(() => {});
}

/**
 * Acquire a per-inbox lock; returns a release fn. Ownership is proven ONLY by a
 * successful `mkdir(recursive:false)` (atomic exclusive create), and stealing is
 * driven by HOLDER LIVENESS, not elapsed wait time: the holder writes an
 * `owner` file ({pid, ts}) on acquire, and a contender steals ONLY when that
 * holder is dead or its heartbeat is stale. So a live holder whose critical
 * section legitimately runs long (a big GC rewrite, a slow disk) is never robbed
 * — which, together with the counter-trusting append below, closes the seq-dup /
 * event-loss window. A generous `hardMs` is a final backstop against a wedged-
 * but-"alive" holder.
 */
async function acquireLock(
  lockDir: string,
  staleMs = 30_000,
  hardMs = 60_000,
): Promise<() => Promise<void>> {
  const ownerFile = path.join(lockDir, "owner");
  const start = Date.now();
  for (;;) {
    try {
      await mkdir(lockDir, { recursive: false });
      await writeFile(ownerFile, JSON.stringify({ pid: process.pid, ts: Date.now() })).catch(
        () => {},
      );
      return async () => {
        await rm(lockDir, { recursive: true, force: true }).catch(() => {});
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const raw = await readFile(ownerFile, "utf8").catch(() => "");
      if (
        shouldStealLock(raw, Date.now(), {
          staleMs,
          hardMs,
          elapsed: Date.now() - start,
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
    const full: NotifyEvent = { ...ev, seq };
    await appendFile(inboxPath(host, parentPid), serializeEvent(full) + "\n");
    await writeFile(seqPath(host, parentPid), String(seq));
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
 * reader). Returns 0 when there are no consumers (nothing to protect).
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
  await writeFile(p, serializeCursor(seq));
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
    if (!livePids.has(p) && !liveChildParentPids.has(p)) {
      await rm(inboxPath(host, p), { force: true }).catch(() => {});
      await rm(seqPath(host, p), { force: true }).catch(() => {});
      // Sanitized cursor dir (matches cursorPath), not a raw host join.
      await rm(cursorDir(host, p), { recursive: true, force: true }).catch(() => {});
      continue;
    }
    // Live inbox — rotate if oversized, but NEVER evict an event above the min
    // consumer cursor (unacked): at-least-once must survive rotation. The size
    // check is a cheap gate; the read→compute→write all happen UNDER the lock so
    // a concurrent appendEvent can't be lost between a stale read and the write.
    const size = await stat(inboxPath(host, p))
      .then((s) => s.size)
      .catch(() => 0);
    if (size > capBytes) {
      const lock = path.join(inboxDir(host), `${p}.lock`);
      const release = await acquireLock(lock);
      try {
        const events = await readInbox(host, p);
        const protectAboveSeq = await minConsumerCursor(host, p);
        const kept = rotateKeep(events, capBytes, protectAboveSeq);
        if (kept.length < events.length) {
          await writeFile(inboxPath(host, p), kept.map(serializeEvent).join("\n") + "\n");
        }
      } finally {
        await release();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Watcher registry — the set of parents currently running `ay notify watch`.
// The daemon scopes its work to these parents (so an unrelated agent's children
// never get an inbox) and stays alive while any watcher is live; a watcher
// refreshes its heartbeat every poll and removes it on exit.
// ---------------------------------------------------------------------------

/** Register / refresh this parent's watch heartbeat. */
export async function heartbeatWatcher(parentPid: number, startedAt: number): Promise<void> {
  await ensureDir(watchersDir());
  await writeFile(
    watcherPath(parentPid),
    JSON.stringify({ pid: parentPid, started_at: startedAt, ts: Date.now() }),
  ).catch(() => {});
}

/** Remove this parent's watch heartbeat (on watch exit). */
export async function clearWatcher(parentPid: number): Promise<void> {
  await rm(watcherPath(parentPid), { force: true }).catch(() => {});
}

/** The set of parent pids with a fresh (non-expired) watch heartbeat. */
export async function liveWatchers(now = Date.now()): Promise<Set<number>> {
  const names = await readdir(watchersDir()).catch(() => [] as string[]);
  const entries: { pid: number; ts: number }[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const raw = await readFile(path.join(watchersDir(), n), "utf8").catch(() => "");
    try {
      const o = JSON.parse(raw) as { pid: number; ts: number };
      if (typeof o?.pid === "number" && typeof o?.ts === "number") entries.push(o);
    } catch {
      /* skip torn heartbeat */
    }
  }
  return liveWatcherPids(entries, now, WATCHER_TTL_MS);
}
