/**
 * `ay notifyd` — the always-on-while-watched detection engine. Polls every
 * WATCHED agent's live state (the runtime-agnostic query layer, so BOTH Rust and
 * TS children are covered), runs the pure debounce router (`notifyRouter.ts`),
 * and appends the decided edges — enriched with a payload the parent can act on
 * without tailing — into each parent's inbox (`notifyStore.ts`).
 *
 * Lifecycle: a host singleton, guarded by an mkdir lock that records its owner
 * pid so a crashed daemon's stale lock is detected and STOLEN (never a permanent
 * deadlock). Scope + liveness are driven by the WATCHER REGISTRY: the daemon only
 * processes children whose parent is currently running `ay notify watch` (so an
 * unrelated agent never gets an inbox), and it stays alive as long as any watcher
 * heartbeat is live, self-exiting only after a grace window with no watchers.
 * `ay notify watch` re-ensures the daemon every poll, so a parent that watches
 * BEFORE spawning children (or across a fan-out gap) always has a live daemon.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import {
  type ChildObservation,
  type PendingNotification,
  type RouterState,
  stepRouter,
} from "./notifyRouter.ts";
import {
  type NotifyEvent,
  daemonLockDir,
  daemonLockOwnerPath,
  notifyDir,
} from "./notifyInbox.ts";
import {
  appendEvent,
  gcInboxes,
  hostId,
  listInboxParents,
  liveWatchers,
  readInbox,
  shouldStealLock,
} from "./notifyStore.ts";
import { deriveLiveState, isPidAlive, listRecords, renderLogTailLines } from "./subcommands.ts";
import { logger } from "./logger.ts";

const POLL_MS = 2000;
const GC_EVERY_TICKS = 30; // ~every 60s
const IDLE_EXIT_GRACE_MS = 60_000; // exit if no watcher this long

const LS_OPTS = { all: true, active: false, json: false, latest: false, cwdScope: null } as const;

/** Short git HEAD of a cwd, best-effort, never blocks emission. */
function gitHead(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "rev-parse", "--short", "HEAD"],
      { timeout: 1500, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout.trim() || null),
    );
  });
}

/** Last few rendered log lines, compacted, so the parent needn't tail. */
async function recentTail(logFile: string | null | undefined): Promise<string | null> {
  if (!logFile) return null;
  const lines = await renderLogTailLines(logFile, 12).catch(() => null);
  if (!lines) return null;
  const compact = lines
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim())
    .slice(-8);
  return compact.length ? compact.join("\n").slice(0, 1200) : null;
}

/**
 * Seed the router's prior state from what each inbox has ALREADY recorded, so a
 * daemon restart does not re-emit a baseline the parent already saw.
 *
 * pid-reuse guard: seed a child ONLY if it is still in the registry with the
 * SAME start time as the inbox recorded (`liveChildren`: pid → started_at). A pid
 * whose live start time differs is a NEW child recycling the pid — seeding it
 * would suppress its first notification, so we skip it (it starts fresh). A pid
 * absent from the registry (reaped) is skipped too: it won't be observed again,
 * and if the pid is later reused, that new child was never seeded.
 */
export async function reconcileFromInboxes(
  host: string,
  liveChildren: Map<number, number>,
): Promise<RouterState> {
  const state: RouterState = new Map();
  for (const parent of await listInboxParents(host)) {
    const events = await readInbox(host, parent);
    const lastByChild = new Map<number, NotifyEvent>();
    const exitedChildren = new Set<number>();
    for (const e of events) {
      lastByChild.set(e.child_pid, e);
      if (e.edge === "exited") exitedChildren.add(e.child_pid);
    }
    for (const [childPid, last] of lastByChild) {
      const liveStarted = liveChildren.get(childPid);
      if (liveStarted === undefined) continue; // reaped / gone — nothing to suppress
      // Seed ONLY on a positively-matched identity. An event with no/zero
      // child_started_at can't be verified, so we don't seed it — better to risk
      // one duplicate edge than to suppress a recycled pid's first notification.
      if (!last.child_started_at || liveStarted !== last.child_started_at) continue;
      const seededState =
        last.edge === "exited"
          ? "stopped"
          : last.edge === "needs_input"
            ? "needs_input"
            : last.edge === "idle"
              ? "idle"
              : "active";
      state.set(childPid, {
        parent_pid: last.parent_pid,
        wrapper_pid: last.child_wrapper_pid,
        // Carry BOTH start times into the seeded state, so the hot-path pid-reuse
        // guard can fire on the next observation and a synthetic exited from this
        // seed still stamps identity (else the guard is blind until re-observed).
        started_at: last.child_started_at,
        parent_started_at: last.parent_started_at,
        cli: last.cli,
        cwd: last.cwd,
        state: seededState,
        idleSince: last.edge === "idle" ? 0 : null,
        idleEmitted: last.edge === "idle",
        inNeedsInput: last.edge === "needs_input",
        needsInputQuestion: last.edge === "needs_input" ? last.question : null,
        exitedEmitted: exitedChildren.has(childPid),
      });
    }
  }
  return state;
}

interface ObserveResult {
  obs: ChildObservation[];
  /** child pid → the parent's started_at, for the pid-reuse guard. */
  parentStartedAt: Map<number, number>;
  /** child pid → the child's OWN started_at, stamped into events (reuse guard). */
  childStartedAt: Map<number, number>;
  /** log file per child pid, for payload enrichment. */
  logFiles: Map<number, string | null>;
  /**
   * EVERY currently-alive child pid in the registry (regardless of whether its
   * parent is watching) — so the router can tell a truly-dead child from one it
   * merely stopped observing when a watcher lapsed.
   */
  aliveChildPids: Set<number>;
  watcherCount: number;
}

/** Observe every child WHOSE PARENT IS WATCHING. Nothing else gets an inbox. */
async function observeChildren(): Promise<ObserveResult> {
  const watching = await liveWatchers();
  const records = await listRecords(undefined, LS_OPTS);
  // Parent wrapper pid → its own started_at (for the pid-reuse stamp).
  const startedAtByWrapper = new Map<number, number>();
  for (const r of records) {
    if (typeof r.wrapper_pid === "number" && r.wrapper_pid > 0)
      startedAtByWrapper.set(r.wrapper_pid, r.started_at);
  }
  const obs: ChildObservation[] = [];
  const parentStartedAt = new Map<number, number>();
  const childStartedAt = new Map<number, number>();
  const logFiles = new Map<number, string | null>();
  // Liveness of ALL children (any parent) — the router uses this to avoid
  // false-exiting a child it merely stopped observing (watcher lapsed).
  const aliveChildPids = new Set<number>();
  for (const r of records) {
    if (typeof r.parent_pid === "number" && r.parent_pid > 0 && isPidAlive(r.pid))
      aliveChildPids.add(r.pid);
  }
  for (const r of records) {
    const parent = r.parent_pid;
    if (typeof parent !== "number" || parent <= 0) continue;
    if (!watching.has(parent)) continue; // scope: only watched parents' children
    const { state, question } = await deriveLiveState(r);
    // Parent start time: prefer the WATCHER's self-reported value (authoritative,
    // never 0) over a registry-wrapper lookup that can miss and stamp a 0 — a 0
    // would slip past the reader's parent pid-reuse guard.
    const parentStart = watching.get(parent) || startedAtByWrapper.get(parent) || 0;
    obs.push({
      pid: r.pid,
      wrapper_pid: r.wrapper_pid ?? undefined,
      started_at: r.started_at,
      parent_pid: parent,
      parent_started_at: parentStart,
      cli: r.cli,
      cwd: r.cwd,
      state,
      question,
    });
    parentStartedAt.set(r.pid, parentStart);
    childStartedAt.set(r.pid, r.started_at);
    logFiles.set(r.pid, r.log_file ?? null);
  }
  return {
    obs,
    parentStartedAt,
    childStartedAt,
    logFiles,
    aliveChildPids,
    watcherCount: watching.size,
  };
}

/** Registry snapshot: every record's pid → its started_at (for reconcile guard). */
async function liveChildrenSnapshot(): Promise<Map<number, number>> {
  const records = await listRecords(undefined, LS_OPTS).catch(() => []);
  const m = new Map<number, number>();
  for (const r of records) m.set(r.pid, r.started_at);
  return m;
}

export interface DaemonOptions {
  intervalMs?: number;
  /** Run a single tick and return (for tests / `--once`), no lock, no loop. */
  once?: boolean;
}

// How long an owner heartbeat stays "trusted" — a running daemon refreshes it
// each tick (POLL_MS), so a recycled pid (which isn't refreshing THIS file) reads
// as stale within a few ticks and is neither trusted for `status` nor killed by
// `stop`. Kept tight (a few ticks) to shrink the pid-reuse window.
const OWNER_TTL_MS = 3 * POLL_MS;

export interface DaemonIdentity {
  pid: number;
  started_at: number;
  ts: number;
}

// The daemon's start time, captured ONCE when it acquires the lock. The
// heartbeat updates only `ts` — never `started_at` — so `stop`'s two-read
// identity check (pid + started_at unchanged) can't see it move and mistake the
// running daemon for "not running".
let daemonStartedAt = 0;
// Fencing token for THIS daemon's lock ownership (see the inbox lock). We only
// overwrite the owner file or delete the lock while it still carries our token,
// so a stale-stolen daemon can't clobber or delete the new daemon's lock.
let daemonToken = "";

/** The token currently written in the daemon lock owner file, or null. */
async function readDaemonOwnerToken(): Promise<string | null> {
  try {
    const o = JSON.parse(await readFile(daemonLockOwnerPath(), "utf8")) as { token?: string };
    return o.token ?? null;
  } catch {
    return null;
  }
}

/** Stamp the lock owner file with our identity + a fresh heartbeat ts + token. */
async function writeOwner(): Promise<void> {
  await writeFile(
    daemonLockOwnerPath(),
    JSON.stringify({ pid: process.pid, started_at: daemonStartedAt, ts: Date.now(), token: daemonToken }),
  ).catch(() => {});
}

/**
 * Acquire the singleton lock. Returns true if WE now hold it, false if a LIVE
 * daemon already does. Shares the inbox lock's invariant: ownership is proven by
 * `mkdir(recursive:false)`, and a lock is stolen only when its owner is dead or
 * its heartbeat is stale — never on a torn/empty owner WITHIN the grace (the
 * mkdir→writeOwner window of another daemon coming up), so two concurrent starts
 * can't both "win". The liveness predicate is injectable for tests.
 */
export async function acquireDaemonLock(isAlive: (pid: number) => boolean = isPidAlive): Promise<boolean> {
  // The lock dir lives under notify/ — ensure that exists first, else mkdir of
  // the lock throws ENOENT which must NOT be mistaken for "someone holds it".
  await mkdir(notifyDir(), { recursive: true }).catch(() => {});
  const start = Date.now();
  for (;;) {
    try {
      await mkdir(daemonLockDir(), { recursive: false });
      daemonStartedAt = Date.now(); // fixed for this daemon's lifetime
      daemonToken = randomUUID(); // fencing token for this ownership
      await writeOwner();
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; // real error — propagate
      const raw = await readFile(daemonLockOwnerPath(), "utf8").catch(() => "");
      const now = Date.now();
      // A COMPLETE, live, fresh owner belonging to a DIFFERENT pid → another
      // daemon is already running; we are not it.
      let owner: { pid?: number; ts?: number } | null = null;
      try {
        owner = JSON.parse(raw) as { pid: number; ts: number };
      } catch {
        /* torn / not-yet-written */
      }
      if (
        owner &&
        typeof owner.pid === "number" &&
        owner.pid > 0 &&
        owner.pid !== process.pid &&
        typeof owner.ts === "number" &&
        now - owner.ts <= OWNER_TTL_MS &&
        isAlive(owner.pid)
      ) {
        return false;
      }
      // Otherwise steal per the SHARED decision (dead / heartbeat-stale /
      // torn-past-grace) — the same invariant the per-inbox lock uses, so a
      // torn owner (the mkdir→writeOwner window of a concurrent daemon start) is
      // respected within the grace and two starts can't both win. Else wait.
      if (
        shouldStealLock(raw, now, {
          staleMs: OWNER_TTL_MS,
          elapsed: now - start,
          selfPid: process.pid,
          isAlive,
        })
      ) {
        await rm(daemonLockDir(), { recursive: true, force: true }).catch(() => {});
        continue;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  }
}

/**
 * Run the daemon loop in the FOREGROUND. `ay notifyd start` spawns this detached;
 * `ay notifyd run` runs it inline. Holds the host singleton lock for its lifetime.
 */
export async function runDaemon(opts: DaemonOptions = {}): Promise<number> {
  const host = hostId();
  const intervalMs = opts.intervalMs ?? POLL_MS;

  if (opts.once) {
    // A single reconciled tick (test/debug). Skip entirely if a real daemon is
    // already running — otherwise we'd re-emit baselines it has handled — and
    // seed from the inbox so even standalone we don't duplicate prior edges.
    if (await daemonStatus()) return 0;
    const prev = await reconcileFromInboxes(host, await liveChildrenSnapshot());
    await tickState(host, prev);
    return 0;
  }

  if (!(await acquireDaemonLock())) {
    logger.debug("[notifyd] another live daemon holds the lock — exiting");
    return 0;
  }

  let running = true;
  // Heartbeat the owner ts on a BACKGROUND timer (not once per loop) so a slow
  // tick — many watched children, slow log I/O — can't let the heartbeat cross
  // OWNER_TTL and have another `watch` steal the lock as "stale" → double daemon.
  // Refresh well inside the TTL; cleared on shutdown.
  const ownerBeat = setInterval(() => {
    void (async () => {
      // Stop beating (and never overwrite) if we've been superseded — the fencing
      // token in the owner file is no longer ours.
      const cur = await readDaemonOwnerToken();
      if (cur !== null && cur !== daemonToken) {
        clearInterval(ownerBeat);
        return;
      }
      await writeOwner();
    })();
  }, Math.max(1000, Math.floor(OWNER_TTL_MS / 3)));
  if (typeof ownerBeat.unref === "function") ownerBeat.unref();
  const cleanup = async () => {
    running = false;
    clearInterval(ownerBeat);
    // Delete the lock ONLY if it still carries our token — never remove a lock a
    // newer daemon now owns.
    if ((await readDaemonOwnerToken()) === daemonToken)
      await rm(daemonLockDir(), { recursive: true, force: true }).catch(() => {});
  };
  process.on("SIGINT", () => void cleanup().then(() => process.exit(0)));
  process.on("SIGTERM", () => void cleanup().then(() => process.exit(0)));

  // Seed the router from prior inbox state, guarded against pid reuse by the
  // current registry snapshot (see reconcileFromInboxes).
  let prev = await reconcileFromInboxes(host, await liveChildrenSnapshot());
  let ticks = 0;
  let emptySince: number | null = null;

  while (running) {
    const { next, watcherCount } = await tickState(host, prev);
    prev = next;
    ticks++;
    if (ticks % GC_EVERY_TICKS === 0) await gcTick(host).catch(() => {});

    // Self-exit when no parent is watching for a grace window.
    if (watcherCount > 0) emptySince = null;
    else if (emptySince == null) emptySince = Date.now();
    if (emptySince != null && Date.now() - emptySince > IDLE_EXIT_GRACE_MS) {
      logger.debug("[notifyd] no watchers — exiting");
      break;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  await cleanup();
  return 0;
}

async function tickState(
  host: string,
  prev: RouterState,
): Promise<{ next: RouterState; watcherCount: number }> {
  const { obs, parentStartedAt, childStartedAt, logFiles, aliveChildPids, watcherCount } =
    await observeChildren();
  const { events, next } = stepRouter(prev, obs, Date.now(), { aliveChildPids });

  // Enrich all edges CONCURRENTLY (a burst of N edges must not serialize N git
  // timeouts). Enrichment is best-effort and never throws; the append that
  // follows stays serial so per-inbox seq allocation is unambiguous.
  const enriched = await Promise.all(
    events.map(async (ev) => {
      let tail: string | null = null;
      let git_head: string | null = null;
      if (ev.edge !== "exited") {
        [tail, git_head] = await Promise.all([
          recentTail(logFiles.get(ev.child_pid)).catch(() => null),
          gitHead(ev.cwd).catch(() => null),
        ]);
      }
      const stored: Omit<NotifyEvent, "seq"> = {
        ts: Date.now(),
        host,
        parent_pid: ev.parent_pid,
        // The parent's/child's start times — the read side and the startup
        // reconcile reject an event whose start time disagrees, guarding pid reuse.
        // Carried by the router so a synthetic exited (child gone from the live
        // set) still stamps the real parent start, not 0 (which would bypass the
        // reader's parent guard). Fall back to the live map, then 0.
        parent_started_at: ev.parent_started_at ?? parentStartedAt.get(ev.child_pid) ?? 0,
        child_pid: ev.child_pid,
        child_wrapper_pid: ev.child_wrapper_pid,
        // Carried by the router (survives a synthetic exited for a vanished child,
        // which is no longer in childStartedAt); fall back to the live map.
        child_started_at: ev.child_started_at ?? childStartedAt.get(ev.child_pid) ?? 0,
        cli: ev.cli,
        cwd: ev.cwd,
        edge: ev.edge,
        prev_state: ev.prev_state,
        state: ev.state,
        question: ev.question,
        tail,
        git_head,
      };
      return stored;
    }),
  );
  for (let i = 0; i < enriched.length; i++) {
    const stored = enriched[i]!;
    const ev = events[i]!;
    const ok = await appendWithRetry(stored);
    if (!ok) {
      // at-least-once: a transient FS/lock failure must NOT permanently drop an
      // edge. Roll back this edge's "emitted" mark in the next state so the next
      // tick re-detects and re-appends it (a duplicate is acceptable; a drop is
      // not). Scoped to this child only — no cross-parent re-emission.
      rollbackEmit(next, ev);
      logger.warn(`[notifyd] append failed for parent ${stored.parent_pid} — will retry next tick`);
    }
  }
  return { next, watcherCount };
}

/** Append with a few quick retries — a transient lock/FS blip shouldn't lose an edge. */
async function appendWithRetry(stored: Omit<NotifyEvent, "seq">, attempts = 3): Promise<boolean> {
  for (let a = 0; a < attempts; a++) {
    try {
      await appendEvent(stored.parent_pid, stored);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 25 * (a + 1)));
    }
  }
  return false;
}

/**
 * Undo the router's "emitted" mark for one edge so the NEXT tick re-emits it
 * (used when its append failed). For a synthetic exited whose child was dropped
 * from `next`, re-insert a minimal tracked state so the vanished-loop re-fires.
 */
function rollbackEmit(next: RouterState, ev: PendingNotification): void {
  const cs = next.get(ev.child_pid);
  if (cs) {
    if (ev.edge === "idle") cs.idleEmitted = false;
    else if (ev.edge === "needs_input") {
      cs.inNeedsInput = false;
      cs.needsInputQuestion = null;
    } else if (ev.edge === "exited") cs.exitedEmitted = false;
    return;
  }
  if (ev.edge === "exited") {
    // Synthetic exited for a child already dropped from tracking — re-add it so
    // the next tick's vanished-loop retries the exited append.
    next.set(ev.child_pid, {
      parent_pid: ev.parent_pid,
      wrapper_pid: ev.child_wrapper_pid,
      started_at: ev.child_started_at,
      parent_started_at: ev.parent_started_at,
      cli: ev.cli,
      cwd: ev.cwd,
      state: ev.prev_state ?? "active",
      idleSince: null,
      idleEmitted: false,
      inNeedsInput: false,
      needsInputQuestion: null,
      exitedEmitted: false,
    });
  }
}

async function gcTick(host: string): Promise<void> {
  const records = await listRecords(undefined, { ...LS_OPTS, all: true }).catch(() => []);
  const livePids = new Set<number>();
  const childParentPids = new Set<number>();
  for (const r of records) {
    if (isPidAlive(r.pid)) livePids.add(r.wrapper_pid ?? r.pid);
    if (typeof r.parent_pid === "number" && r.parent_pid > 0 && isPidAlive(r.pid))
      childParentPids.add(r.parent_pid);
  }
  await gcInboxes(host, livePids, childParentPids);
}

/**
 * The running daemon's full identity, or null. The lock owner file is the SINGLE
 * source of truth: trusted only if it is COMPLETE (pid + started_at + ts), its
 * pid is alive, AND its heartbeat is fresh. A recycled pid isn't refreshing this
 * file, so its stale ts (or a torn/partial owner) yields null — we never trust or
 * kill an unrelated process. `stop` re-reads and re-checks this identity right
 * before signalling, so it can't SIGTERM a pid recycled between status and stop.
 *
 * Residual edge (documented, not yet closed): a pid recycled onto an UNRELATED
 * live process WITHIN the tight OWNER_TTL window (a few ticks) could be briefly
 * trusted, since we compare our recorded `started_at` against the owner file, not
 * against the OS's actual process start time (which is non-portable to read:
 * `/proc/<pid>/stat` on Linux vs `proc_pidinfo`/`ps -o lstart` on macOS). The
 * heartbeat freshness + tight TTL keep the window to seconds; a real OS
 * start-time cross-check is deferred to a future issue.
 */
export async function daemonIdentity(now = Date.now()): Promise<DaemonIdentity | null> {
  const raw = await readFile(daemonLockOwnerPath(), "utf8").catch(() => "");
  try {
    const o = JSON.parse(raw) as Partial<DaemonIdentity>;
    if (
      typeof o?.pid === "number" &&
      o.pid > 0 &&
      typeof o.started_at === "number" &&
      o.started_at > 0 &&
      typeof o.ts === "number" &&
      now - o.ts <= OWNER_TTL_MS &&
      isPidAlive(o.pid)
    ) {
      return { pid: o.pid, started_at: o.started_at, ts: o.ts };
    }
  } catch {
    /* missing / torn owner — no daemon */
  }
  return null;
}

/** The running daemon's pid, or null (see daemonIdentity for the trust rules). */
export async function daemonStatus(now = Date.now()): Promise<number | null> {
  return (await daemonIdentity(now))?.pid ?? null;
}

/** Ensure a daemon is running; best-effort spawn detached. Returns its pid or null. */
export async function ensureDaemon(): Promise<number | null> {
  const existing = await daemonStatus();
  if (existing) return existing;
  const { spawn } = await import("node:child_process");
  // Resolve our own launcher the way serve/schedule do: on POSIX `ay` is a
  // `#!/usr/bin/env bun` script (run via process.execPath), on Windows it's a
  // self-contained ay.exe. Fall back to a bare `ay` on PATH.
  const ayBin = Bun.which("ay");
  const launcher = ayBin
    ? process.platform === "win32"
      ? [ayBin]
      : [process.execPath, ayBin]
    : ["ay"];
  const [cmd, ...pre] = launcher;
  const child = spawn(cmd!, [...pre, "notifyd", "run"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  // Give it a moment to acquire the lock + stamp its owner file.
  await new Promise((r) => setTimeout(r, 300));
  return daemonStatus();
}
