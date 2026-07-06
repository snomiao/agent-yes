/**
 * `ay notifyd` — the always-on-while-watched detection engine. Polls every
 * agent's live state (the runtime-agnostic query layer, so BOTH Rust and TS
 * children are covered), runs the pure debounce router (`notifyRouter.ts`), and
 * appends the decided edges — enriched with a payload the parent can act on
 * without tailing — into each parent's inbox (`notifyStore.ts`).
 *
 * Lifecycle: a host singleton (mkdir lock). Started on demand by
 * `ay notify watch --ensure-daemon` (default) or explicitly via
 * `ay notifyd start`. Self-exits after a grace window with nothing to watch, so
 * it never lingers as a zombie. It is opt-IN at the consumer: if no parent ever
 * watches, the daemon is never started and NO files are created — fully
 * backward compatible with existing flows (the Monitor-on-HEAD polling keeps
 * working unchanged, now strictly dominated by this).
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
  daemonPidPath,
} from "./notifyInbox.ts";
import {
  appendEvent,
  gcInboxes,
  hostId,
  listInboxParents,
  readInbox,
} from "./notifyStore.ts";
import { deriveLiveState, isPidAlive, listRecords, renderLogTailLines } from "./subcommands.ts";
import { logger } from "./logger.ts";

const POLL_MS = 2000;
const GC_EVERY_TICKS = 30; // ~every 60s
const IDLE_EXIT_GRACE_MS = 60_000; // exit if nothing to watch this long

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
 * daemon restart does not re-emit a baseline the parent already saw. For each
 * child we reconstruct the emitted-edge memory from its last (and any exited)
 * event.
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
        // A still-idle child keeps idleEmitted so we don't re-fire across restart.
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

/** Build this tick's observations for every child that has a parent. */
async function observeChildren(): Promise<{ obs: ChildObservation[]; childParentPids: Set<number> }> {
  const records = await listRecords(undefined, LS_OPTS);
  const obs: ChildObservation[] = [];
  const childParentPids = new Set<number>();
  for (const r of records) {
    const parent = r.parent_pid;
    if (typeof parent !== "number" || parent <= 0) continue;
    childParentPids.add(parent);
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
  }
  return { obs, childParentPids };
}

export interface DaemonOptions {
  intervalMs?: number;
  /** Run a single tick and return (for tests / `--once`), no lock, no loop. */
  once?: boolean;
}

/**
 * Run the daemon loop in the FOREGROUND. `ay notifyd start` spawns this detached;
 * `ay notifyd run` runs it inline. Holds the host singleton lock for its lifetime.
 */
export async function runDaemon(opts: DaemonOptions = {}): Promise<number> {
  const host = hostId();
  const intervalMs = opts.intervalMs ?? POLL_MS;

  if (opts.once) {
    await tick(host, new Map());
    return 0;
  }

  // Singleton guard: whoever holds the mkdir lock is THE daemon.
  try {
    await mkdir(daemonLockDir(), { recursive: false });
  } catch {
    logger.debug("[notifyd] another daemon already holds the lock — exiting");
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
    const hadWork = await tickState(host, prev).then((r) => {
      prev = r.next;
      return r.hadChildren;
    });
    ticks++;
    if (ticks % GC_EVERY_TICKS === 0) await gcTick(host).catch(() => {});

    // Self-exit when there's nothing to watch for a grace window.
    if (hadWork) emptySince = null;
    else if (emptySince == null) emptySince = Date.now();
    if (emptySince != null && Date.now() - emptySince > IDLE_EXIT_GRACE_MS) {
      logger.debug("[notifyd] nothing to watch — exiting");
      break;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  await cleanup();
  return 0;
}

/** One tick used by `--once` (no state threading). */
async function tick(host: string, prev: RouterState): Promise<void> {
  await tickState(host, prev);
}

async function tickState(
  host: string,
  prev: RouterState,
): Promise<{ next: RouterState; hadChildren: boolean }> {
  const { obs, childParentPids } = await observeChildren();
  const { events, next } = stepRouter(prev, obs, Date.now());
  for (const ev of events) {
    // Enrich: tail + git head for actionable edges; exited is best-effort (log
    // may already be reaped). Never let git/log I/O block or crash emission.
    let tail: string | null = null;
    let git_head: string | null = null;
    try {
      const rec = obs.find((o) => o.pid === ev.child_pid);
      if (rec && ev.edge !== "exited") {
        [tail, git_head] = await Promise.all([
          recentTailForPid(ev.child_pid),
          gitHead(rec.cwd),
        ]);
      }
    } catch {
      /* enrichment is best-effort */
    }
    const stored: Omit<NotifyEvent, "seq"> = {
      ts: Date.now(),
      host,
      parent_pid: ev.parent_pid,
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
  return { next, hadChildren: childParentPids.size > 0 };
}

// Resolve a child's log file to render its tail. We re-read the record set here
// only for the (rare) emit path, keeping the hot observe path lean.
async function recentTailForPid(childPid: number): Promise<string | null> {
  const records = await listRecords(undefined, LS_OPTS).catch(() => []);
  const r = records.find((x) => x.pid === childPid);
  return recentTail(r?.log_file);
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
