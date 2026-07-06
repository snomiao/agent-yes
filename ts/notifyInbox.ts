/**
 * Pure, fs-free core for the subagent→parent notification inbox — the storage
 * and watermark layer under `ay notify` / `ay notifyd`.
 *
 * Motivation (real incident): a parent agent fanned out sub-agents that finished
 * their work but sat at an idle `❯` prompt WITHOUT exiting (claude-yes does not
 * exit on idle). Claude Code's background-task notification only fires on process
 * EXIT, so the parent never learned the children went idle and left them parked
 * 16 minutes. `ay ls --watch` already streams transitions, but it is PULL: the
 * parent must run the watch loop. The whole point of this pain is the parent is
 * NOT watching. So we accumulate qualifying edges into a per-parent append-only
 * inbox that the parent drains on its own schedule (its Monitor loop), with a
 * persisted cursor so a parent that restarts reads only the unread edges.
 *
 * This module is the pure part (path math, NDJSON (de)serialization, seq/cursor
 * filtering, retention decisions) so it is trivially unit-testable, mirroring
 * `lsWatch.ts` / `needsInput.ts` / `resultEnvelope.ts`. The fs read/write + lock
 * + CLI live in `subcommands.ts`; the detection/debounce lives in
 * `notifyRouter.ts`.
 */

import path from "path";
import { agentYesHome } from "./agentYesHome.ts";

/** The three edges we deliver — the inverse of "background notify on EXIT only". */
export type NotifyEdge = "needs_input" | "idle" | "exited";

/**
 * One notification, as stored (one NDJSON line) and streamed. `seq` is the
 * authoritative monotonic watermark within a single parent inbox; `ts` is a
 * display/filter convenience (clock skew means it is NOT the ordering key).
 */
export interface NotifyEvent {
  /** Monotonic per-inbox sequence; the watermark a cursor compares against. */
  seq: number;
  ts: number;
  /** Local host id (pid namespace is per-host); also encoded in the path. */
  host: string;
  /** The parent this edge is addressed to (parent wrapper pid). */
  parent_pid: number;
  /** Parent's start time, to reject a pid-reuse mismatch on read. Optional. */
  parent_started_at?: number;
  /** The child that transitioned. */
  child_pid: number;
  child_wrapper_pid?: number;
  cli: string;
  cwd: string;
  edge: NotifyEdge;
  /** The state the child was in before this edge (for context). */
  prev_state: string | null;
  /** The child's state now (redundant with `edge` but explicit). */
  state: string;
  /** Compact question text when edge === "needs_input", else null. */
  question: string | null;
  /** Best-effort recent output tail (last few lines), so the parent needn't tail. */
  tail?: string | null;
  /** Best-effort short git HEAD of the child's cwd. */
  git_head?: string | null;
}

/** Root dir for all notification state. */
export function notifyDir(): string {
  return path.join(agentYesHome(), "notify");
}

/** Per-host inbox directory (pids are only unique within a host). */
export function inboxDir(host: string): string {
  return path.join(notifyDir(), "inbox", sanitizeHost(host));
}

/** Absolute path of one parent's append-only NDJSON inbox. */
export function inboxPath(host: string, parentPid: number): string {
  return path.join(inboxDir(host), `${parentPid}.ndjson`);
}

/** Sidecar seq counter for a parent inbox (last allocated seq). */
export function seqPath(host: string, parentPid: number): string {
  return path.join(inboxDir(host), `${parentPid}.seq`);
}

/** Per-consumer cursor directory for a parent inbox. */
export function cursorDir(host: string, parentPid: number): string {
  return path.join(notifyDir(), "cursors", sanitizeHost(host), String(parentPid));
}

/** Absolute path of one consumer's cursor file for a parent inbox. */
export function cursorPath(host: string, parentPid: number, consumer = "parent"): string {
  return path.join(cursorDir(host, parentPid), `${sanitizeConsumer(consumer)}.json`);
}

/** Opt-in marker directory — a child that spawned with `--notify-parent`. */
export function optinDir(): string {
  return path.join(notifyDir(), "optin");
}

/** Marker path for one opted-in child (keyed by its wrapper pid). */
export function optinMarkerPath(childWrapperPid: number): string {
  return path.join(optinDir(), `${childWrapperPid}.json`);
}

/** The daemon singleton lock dir (mkdir-based, like pidStore). */
export function daemonLockDir(): string {
  return path.join(notifyDir(), "notifyd.lock");
}

/** Where the running daemon records its pid, for `ay notifyd status/stop`. */
export function daemonPidPath(): string {
  return path.join(notifyDir(), "notifyd.pid");
}

// Path-segment hygiene: a hostname or consumer label must never escape the
// notify dir or collide via separators. Keep it filesystem-safe and stable.
function sanitizeHost(host: string): string {
  return host.replace(/[^A-Za-z0-9._-]/g, "_") || "localhost";
}
function sanitizeConsumer(consumer: string): string {
  return consumer.replace(/[^A-Za-z0-9._-]/g, "_") || "parent";
}

/** Serialize one event to its NDJSON line (no trailing newline). */
export function serializeEvent(ev: NotifyEvent): string {
  return JSON.stringify(ev);
}

/**
 * Parse an inbox's raw text into events. Tolerant by design: a torn final line
 * (a writer mid-append) or any unparseable line is skipped, never throws — a
 * reader must survive a concurrent writer. Order is file order (= seq order,
 * since a single locked writer appends in increasing seq).
 */
export function parseInboxText(text: string): NotifyEvent[] {
  const out: NotifyEvent[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = JSON.parse(t) as NotifyEvent;
      if (ev && typeof ev.seq === "number" && typeof ev.edge === "string") out.push(ev);
    } catch {
      /* torn / malformed line — skip */
    }
  }
  return out;
}

/** Next seq to allocate given the last stored seq counter (or the inbox max). */
export function nextSeq(lastSeq: number): number {
  return (Number.isFinite(lastSeq) && lastSeq > 0 ? lastSeq : 0) + 1;
}

/** Highest seq present in a parsed inbox (0 when empty). */
export function maxSeq(events: NotifyEvent[]): number {
  let m = 0;
  for (const e of events) if (e.seq > m) m = e.seq;
  return m;
}

/**
 * Filter events for `--since <seq>`: strictly-greater than the given seq. A
 * `since` of 0/undefined returns everything.
 */
export function filterSinceSeq(events: NotifyEvent[], sinceSeq: number | undefined): NotifyEvent[] {
  if (!sinceSeq || sinceSeq <= 0) return events.slice();
  return events.filter((e) => e.seq > sinceSeq);
}

/** Filter events after a wall-clock `--since <ts>` (inclusive lower bound). */
export function filterSinceTs(events: NotifyEvent[], sinceTs: number | undefined): NotifyEvent[] {
  if (!sinceTs || sinceTs <= 0) return events.slice();
  return events.filter((e) => e.ts >= sinceTs);
}

/** Unread = seq strictly greater than the consumer's cursor. */
export function filterUnread(events: NotifyEvent[], cursorSeq: number): NotifyEvent[] {
  return events.filter((e) => e.seq > (cursorSeq > 0 ? cursorSeq : 0));
}

export interface Cursor {
  seq: number;
}

/** Parse a cursor file's text; a missing/garbage cursor reads as seq 0. */
export function parseCursor(text: string | null | undefined): Cursor {
  if (!text) return { seq: 0 };
  try {
    const c = JSON.parse(text) as Cursor;
    return { seq: Number.isFinite(c?.seq) && c.seq > 0 ? c.seq : 0 };
  } catch {
    return { seq: 0 };
  }
}

export function serializeCursor(seq: number): string {
  return JSON.stringify({ seq: Math.max(0, Math.floor(seq)) } satisfies Cursor);
}

/**
 * Retention decision (pure): which parent inboxes are eligible for GC. An inbox
 * is collectable when its parent pid is no longer alive AND no live child still
 * references it as a parent — then nobody will read or write it again. The
 * caller supplies the live-pid set and the live child→parent references it
 * gathered from the registry.
 */
export function inboxesToGC(
  inboxParentPids: number[],
  livePids: Set<number>,
  liveChildParentPids: Set<number>,
): number[] {
  return inboxParentPids.filter((p) => !livePids.has(p) && !liveChildParentPids.has(p));
}

/**
 * Rotation decision (pure): given an inbox's events and a byte cap, return the
 * events to KEEP after rotating. We never drop an event at-or-below the minimum
 * un-acked cursor is the caller's concern; here we keep the newest events whose
 * serialized size fits the cap, always preserving at least `minKeep` newest.
 */
export function rotateKeep(events: NotifyEvent[], capBytes: number, minKeep = 100): NotifyEvent[] {
  if (events.length <= minKeep) return events.slice();
  const kept: NotifyEvent[] = [];
  let bytes = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const line = serializeEvent(events[i]!) + "\n";
    bytes += line.length;
    if (bytes > capBytes && kept.length >= minKeep) break;
    kept.push(events[i]!);
  }
  kept.reverse();
  return kept;
}
