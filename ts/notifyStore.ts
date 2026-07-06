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
  cursorPath,
  inboxDir,
  inboxPath,
  maxSeq,
  nextSeq,
  notifyDir,
  parseCursor,
  parseInboxText,
  rotateKeep,
  seqPath,
  serializeCursor,
  serializeEvent,
} from "./notifyInbox.ts";

/** Stable local host id — the pid namespace is per-host. */
export function hostId(): string {
  return os.hostname() || "localhost";
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true }).catch(() => {});
}

/** Acquire a per-inbox mkdir lock; returns a release fn. Best-effort, bounded. */
async function acquireLock(lockDir: string, timeoutMs = 2000): Promise<() => Promise<void>> {
  const start = Date.now();
  // Back off between attempts; the critical section is tiny so this rarely loops.
  for (;;) {
    try {
      await mkdir(lockDir, { recursive: false });
      return async () => {
        await rm(lockDir, { recursive: true, force: true }).catch(() => {});
      };
    } catch {
      if (Date.now() - start > timeoutMs) {
        // Stale lock (a crashed writer) — steal it rather than deadlock. The
        // critical section is idempotent-safe on seq via re-read below.
        await rm(lockDir, { recursive: true, force: true }).catch(() => {});
        await mkdir(lockDir, { recursive: true }).catch(() => {});
        return async () => {
          await rm(lockDir, { recursive: true, force: true }).catch(() => {});
        };
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
      await rm(path.join(notifyDir(), "cursors", host, String(p)), {
        recursive: true,
        force: true,
      }).catch(() => {});
      continue;
    }
    // Live inbox — rotate if oversized.
    const size = await stat(inboxPath(host, p))
      .then((s) => s.size)
      .catch(() => 0);
    if (size > capBytes) {
      const events = await readInbox(host, p);
      const kept = rotateKeep(events, capBytes);
      if (kept.length < events.length) {
        const lock = path.join(inboxDir(host), `${p}.lock`);
        const release = await acquireLock(lock);
        try {
          await writeFile(inboxPath(host, p), kept.map(serializeEvent).join("\n") + "\n");
        } finally {
          await release();
        }
      }
    }
  }
}
