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

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true }).catch(() => {});
}

/**
 * Acquire a per-inbox mkdir lock; returns a release fn. Ownership is proven ONLY
 * by a successful `mkdir(recursive:false)` — the atomic, exclusive create. A
 * presumed-stale lock (held past `staleMs`) is removed ONCE and then we re-
 * contend: whoever's next `mkdir` succeeds owns it, so two would-be stealers can
 * never both enter the critical section (the loser EEXISTs and keeps waiting).
 */
async function acquireLock(
  lockDir: string,
  staleMs = 2000,
  hardMs = 10_000,
): Promise<() => Promise<void>> {
  const start = Date.now();
  let stole = false;
  for (;;) {
    try {
      await mkdir(lockDir, { recursive: false });
      return async () => {
        await rm(lockDir, { recursive: true, force: true }).catch(() => {});
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const elapsed = Date.now() - start;
      if (elapsed > hardMs) throw new Error(`notify lock timed out: ${lockDir}`);
      // Remove the presumed-stale lock at most once, then loop back to re-contend
      // — the next mkdir(recursive:false) is the sole ownership proof.
      if (elapsed > staleMs && !stole) {
        stole = true;
        await rm(lockDir, { recursive: true, force: true }).catch(() => {});
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
    // Prefer the sidecar counter; fall back to scanning the inbox (self-heals if
    // the counter is lost). Guarantees a strictly increasing per-inbox seq.
    let last = 0;
    const counterRaw = await readFile(seqPath(host, parentPid), "utf8").catch(() => "");
    const parsed = parseInt(counterRaw.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) last = parsed;
    const existing = parseInboxText(
      await readFile(inboxPath(host, parentPid), "utf8").catch(() => ""),
    );
    last = Math.max(last, maxSeq(existing));
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
