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
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import {
  type ChildObservation,
  type RouterState,
  stepRouter,
} from "./notifyRouter.ts";
import {
  type NotifyEvent,
  daemonLockDir,
  daemonLockOwnerPath,
  daemonPidPath,
  notifyDir,
} from "./notifyInbox.ts";
import {
  appendEvent,
  gcInboxes,
  hostId,
  listInboxParents,
  liveWatchers,
  readInbox,
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
 */
async function reconcileFromInboxes(host: string): Promise<RouterState> {
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
  /** log file per child pid, for payload enrichment. */
  logFiles: Map<number, string | null>;
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
  const logFiles = new Map<number, string | null>();
  for (const r of records) {
    const parent = r.parent_pid;
    if (typeof parent !== "number" || parent <= 0) continue;
    if (!watching.has(parent)) continue; // scope: only watched parents' children
    const { state, question } = await deriveLiveState(r);
    obs.push({
      pid: r.pid,
      wrapper_pid: r.wrapper_pid ?? undefined,
      parent_pid: parent,
      cli: r.cli,
      cwd: r.cwd,
      state,
      question,
    });
    parentStartedAt.set(r.pid, startedAtByWrapper.get(parent) ?? 0);
    logFiles.set(r.pid, r.log_file ?? null);
  }
  return { obs, parentStartedAt, logFiles, watcherCount: watching.size };
}

export interface DaemonOptions {
  intervalMs?: number;
  /** Run a single tick and return (for tests / `--once`), no lock, no loop. */
  once?: boolean;
}

/**
 * Acquire the singleton lock, stealing a stale one whose owner is dead. The
 * liveness predicate is injectable so the steal/keep race is unit-testable.
 * Returns true if WE now hold the lock, false if a LIVE owner holds it.
 */
export async function acquireDaemonLock(isAlive: (pid: number) => boolean = isPidAlive): Promise<boolean> {
  // The lock dir lives under notify/ — ensure that exists first, else mkdir of
  // the lock throws ENOENT which must NOT be mistaken for "someone holds it".
  await mkdir(notifyDir(), { recursive: true }).catch(() => {});
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await mkdir(daemonLockDir(), { recursive: false });
      await writeFile(
        daemonLockOwnerPath(),
        JSON.stringify({ pid: process.pid, started_at: Date.now() }),
      ).catch(() => {});
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; // real error — propagate
      // Lock exists — is its owner still alive?
      const raw = await readFile(daemonLockOwnerPath(), "utf8").catch(() => "");
      let ownerPid = 0;
      try {
        ownerPid = (JSON.parse(raw) as { pid: number }).pid ?? 0;
      } catch {
        /* missing/torn owner — treat as stale */
      }
      if (ownerPid > 0 && ownerPid !== process.pid && isAlive(ownerPid)) return false; // live daemon
      // Stale (dead owner or unreadable) — steal and retry.
      await rm(daemonLockDir(), { recursive: true, force: true }).catch(() => {});
    }
  }
  return false;
}

/**
 * Run the daemon loop in the FOREGROUND. `ay notifyd start` spawns this detached;
 * `ay notifyd run` runs it inline. Holds the host singleton lock for its lifetime.
 */
export async function runDaemon(opts: DaemonOptions = {}): Promise<number> {
  const host = hostId();
  const intervalMs = opts.intervalMs ?? POLL_MS;

  if (opts.once) {
    await tickState(host, new Map());
    return 0;
  }

  if (!(await acquireDaemonLock())) {
    logger.debug("[notifyd] another live daemon holds the lock — exiting");
    return 0;
  }
  await writeFile(daemonPidPath(), String(process.pid)).catch(() => {});

  let running = true;
  const cleanup = async () => {
    running = false;
    await rm(daemonLockDir(), { recursive: true, force: true }).catch(() => {});
    await rm(daemonPidPath(), { force: true }).catch(() => {});
  };
  process.on("SIGINT", () => void cleanup().then(() => process.exit(0)));
  process.on("SIGTERM", () => void cleanup().then(() => process.exit(0)));

  let prev = await reconcileFromInboxes(host);
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
  const { obs, parentStartedAt, logFiles, watcherCount } = await observeChildren();
  const { events, next } = stepRouter(prev, obs, Date.now());
  for (const ev of events) {
    // Enrich: tail + git head for actionable edges; exited is best-effort (the
    // log may already be reaped). Never let git/log I/O block or crash emission.
    let tail: string | null = null;
    let git_head: string | null = null;
    try {
      if (ev.edge !== "exited") {
        [tail, git_head] = await Promise.all([
          recentTail(logFiles.get(ev.child_pid)),
          gitHead(ev.cwd),
        ]);
      }
    } catch {
      /* enrichment is best-effort */
    }
    const stored: Omit<NotifyEvent, "seq"> = {
      ts: Date.now(),
      host,
      parent_pid: ev.parent_pid,
      // The parent's start time — the read side rejects an event whose parent
      // started_at doesn't match the reader's, guarding against pid reuse.
      parent_started_at: parentStartedAt.get(ev.child_pid) ?? 0,
      child_pid: ev.child_pid,
      child_wrapper_pid: ev.child_wrapper_pid,
      cli: ev.cli,
      cwd: ev.cwd,
      edge: ev.edge,
      prev_state: ev.prev_state,
      state: ev.state,
      question: ev.question,
      tail,
      git_head,
    };
    await appendEvent(ev.parent_pid, stored).catch((e) =>
      logger.warn(`[notifyd] append failed for parent ${ev.parent_pid}: ${e}`),
    );
  }
  return { next, watcherCount };
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

/** Read the daemon's recorded pid, or null. */
export async function daemonStatus(): Promise<number | null> {
  const raw = await readFile(daemonPidPath(), "utf8").catch(() => "");
  const pid = parseInt(raw.trim(), 10);
  if (Number.isFinite(pid) && pid > 0 && isPidAlive(pid)) return pid;
  return null;
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
  // Give it a moment to acquire the lock + write its pidfile.
  await new Promise((r) => setTimeout(r, 300));
  return daemonStatus();
}
