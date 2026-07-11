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
import { mkdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import {
  type ChildObservation,
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
  watchedParents: Set<number>,
): Promise<RouterState> {
  const state: RouterState = new Map();
  for (const parent of await listInboxParents(host)) {
    // Scope to CURRENTLY-watched parents only. Seeding an unwatched parent's
    // inbox would let this daemon carry its children forward and later write a
    // synthetic exited into an inbox nobody is watching — violating "nothing
    // happens unless you watch".
    if (!watchedParents.has(parent)) continue;
    const events = await readInbox(host, parent);
    const lastByChild = new Map<number, NotifyEvent>();
    for (const e of events) lastByChild.set(e.child_pid, e);
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
        // "Never suppress, duplicate OK": do NOT seed the idle/needs_input emitted
        // memory. If notifyd was down while a child went idle→active→idle, the new
        // idle episode (the "probably done" signal — this feature's whole point)
        // must NOT be swallowed as the "same" pre-restart episode. So a restart
        // RE-CONFIRMS idle/needs_input as a fresh episode (a duplicate on the wire
        // is acceptable; a lost edge is not). Only `exited` — a terminal state
        // that can't recur for the same child — keeps its emitted flag to avoid a
        // pointless duplicate. Identity (start times) is still seeded so the
        // hot-path pid-reuse guard works on the next observation.
        idleSince: null,
        idleEmitted: false,
        inNeedsInput: false,
        needsInputQuestion: null,
        // Identity-aware: `last` already matched this incarnation's start time, so
        // exitedEmitted is true ONLY if THIS child's last recorded edge is exited.
        // A pid reused by a NEW child (whose last edge is e.g. idle) does NOT
        // inherit the prior incarnation's exit — its own exit still fires.
        exitedEmitted: last.edge === "exited",
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
   * pid → started_at for EVERY currently-alive child in the registry (regardless
   * of whether its parent is watching) — so the router can tell a truly-dead (or
   * pid-reused) child from one it merely stopped observing when a watcher lapsed,
   * identity-aware.
   */
  aliveChildStartedAt: Map<number, number>;
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
  // Liveness of ALL children (any parent), pid → started_at — the router uses
  // this to avoid false-exiting a child it merely stopped observing (watcher
  // lapsed), while still exiting a pid reused by a different child. Only a CURRENT
  // (non-exited) record whose pid is alive counts as liveness evidence: a stale
  // `exited` record must not vouch for a pid that a different process now reuses
  // (which would make the router suppress the old child's exited forever).
  const aliveChildStartedAt = new Map<number, number>();
  for (const r of records) {
    if (
      typeof r.parent_pid === "number" &&
      r.parent_pid > 0 &&
      r.status !== "exited" &&
      isPidAlive(r.pid)
    )
      aliveChildStartedAt.set(r.pid, r.started_at);
  }
  for (const r of records) {
    const parent = r.parent_pid;
    if (typeof parent !== "number" || parent <= 0) continue;
    if (!watching.has(parent)) continue; // scope: only watched parents' children
    // Cross-session guard: a child cannot predate its parent, so a child of THIS
    // watcher incarnation must have started at/after it. Exclude a stale orphan
    // spawned under a PRIOR agent that held this pid (now recycled by the current
    // watcher) — otherwise its state/tail/question would be mis-delivered to an
    // unrelated session. (The child record carries parent_pid but not the parent's
    // start time, so we rely on the invariant child.started_at >= parent.started_at;
    // pids are unique among live processes, so pid-match + this bound pins the
    // exact incarnation.)
    const watcherStart = watching.get(parent) ?? 0;
    if (watcherStart > 0 && r.started_at < watcherStart) continue;
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
    aliveChildStartedAt,
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

// How long an owner heartbeat stays "trusted". A background timer refreshes it
// every OWNER_TTL/3 (decoupled from tick duration). Set comfortably ABOVE any
// realistic SYNCHRONOUS event-loop block, so a slow tick can't let the heartbeat
// go stale and have another `watch` steal the singleton lock → double daemon.
// The daemon loop is all `await`s (log render + git are async, reconcile runs
// once at startup), so it never blocks the loop for seconds — but a single-
// threaded JS process can only bound, not eliminate, an event-loop-block false
// steal (a worker-isolated heartbeat would be needed to close it; tracked as a
// follow-up). 30s also bounds the `stop` pid-reuse window (mitigated further by
// the pid+started_at re-check before SIGTERM).
const OWNER_TTL_MS = 30_000;

export interface DaemonIdentity {
  pid: number;
  started_at: number;
  ts: number;
  /** The owner fencing token at validation time — pins THIS incarnation. */
  token: string | null;
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

/**
 * Stamp the lock owner file with our identity + a fresh heartbeat ts + token,
 * ATOMICALLY (temp + rename) so a reader (status/stop/another daemon) never sees
 * a torn owner mid-write — a null read then reliably means "no owner file yet".
 */
async function writeOwner(): Promise<boolean> {
  const tmp = `${daemonLockOwnerPath()}.${daemonToken}.tmp`;
  try {
    await writeFile(
      tmp,
      JSON.stringify({ pid: process.pid, started_at: daemonStartedAt, ts: Date.now(), token: daemonToken }),
    );
    await rename(tmp, daemonLockOwnerPath());
    return true;
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
    return false;
  }
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
  for (;;) {
    try {
      await mkdir(daemonLockDir(), { recursive: false });
      daemonStartedAt = Date.now(); // fixed for this daemon's lifetime
      daemonToken = randomUUID(); // fencing token for this ownership
      // If we can't write our owner file, we don't own the lock — drop and retry.
      if (!(await writeOwner())) {
        await rm(daemonLockDir(), { recursive: true, force: true }).catch(() => {});
        await new Promise((r) => setTimeout(r, 15));
        continue;
      }
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
      const lockAgeMs =
        now -
        (await stat(daemonLockDir())
          .then((s) => s.mtimeMs)
          .catch(() => now));
      if (
        shouldStealLock(raw, now, {
          staleMs: OWNER_TTL_MS,
          lockAgeMs,
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
    const watched = new Set((await liveWatchers()).keys());
    const prev = await reconcileFromInboxes(host, await liveChildrenSnapshot(), watched);
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
      // Refresh ONLY while the owner still carries OUR token. Any other value — a
      // different token (superseded) OR null/absent (a new daemon's mkdir→write
      // window) — means we no longer own it, so stop rather than clobber an
      // unknown/absent owner. Atomic writeOwner means a null read is never our own
      // write in flight.
      if ((await readDaemonOwnerToken()) !== daemonToken) {
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

  // Seed the router from prior inbox state — scoped to currently-watched parents
  // and guarded against pid reuse by the current registry snapshot.
  const watchedAtStart = new Set((await liveWatchers()).keys());
  let prev = await reconcileFromInboxes(
    host,
    await liveChildrenSnapshot(),
    watchedAtStart,
  );
  let ticks = 0;
  let emptySince: number | null = null;
  // Durable across ticks: edges whose append failed, retried until they land.
  const pendingRetry = new Map<string, Omit<NotifyEvent, "seq">>();

  while (running) {
    // Cooperative stop: `notify notifyd stop` removes our lock rather than
    // SIGTERM-ing a possibly-recycled pid. If our lock is gone (or taken over),
    // exit gracefully.
    if ((await readDaemonOwnerToken()) !== daemonToken) {
      logger.debug("[notifyd] lock lost/removed — exiting");
      break;
    }
    const { next, watcherCount } = await tickState(host, prev, pendingRetry);
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

/**
 * A durable-in-memory retry queue for edges whose append failed. Keyed by the
 * event's identity so a pid reused by a different child never collides (the key
 * includes child_started_at). The router state is NOT rolled back on failure —
 * re-delivery is owned entirely by this queue, so a failed OLD-child exited and
 * the NEW same-pid child's edges are retried independently (at-least-once per
 * event). Bounded so a permanently-unwritable inbox can't grow it without bound.
 */
const RETRY_CAP = 1000;
function retryKey(e: Omit<NotifyEvent, "seq">): string {
  return `${e.parent_pid}:${e.child_pid}:${e.child_started_at ?? 0}:${e.edge}:${e.ts}`;
}

async function tickState(
  host: string,
  prev: RouterState,
  pendingRetry: Map<string, Omit<NotifyEvent, "seq">> = new Map(),
): Promise<{ next: RouterState; watcherCount: number }> {
  // First, retry anything a previous tick couldn't append (transient FS/lock
  // blip). Success removes it; a persistent failure stays queued for next tick.
  for (const [k, stored] of pendingRetry) {
    if (await appendWithRetry(stored)) pendingRetry.delete(k);
  }

  const { obs, parentStartedAt, childStartedAt, logFiles, aliveChildStartedAt, watcherCount } =
    await observeChildren();
  const { events, next } = stepRouter(prev, obs, Date.now(), { aliveChildStartedAt });

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
  for (const stored of enriched) {
    if (await appendWithRetry(stored)) continue;
    // at-least-once: a transient FS/lock failure must NOT drop an edge. Queue it
    // by IDENTITY for re-append on a later tick — never touch the router state
    // (which is keyed by pid and can't hold both an old and a new same-pid child).
    if (pendingRetry.size < RETRY_CAP) {
      pendingRetry.set(retryKey(stored), stored);
      logger.warn(`[notifyd] append failed for parent ${stored.parent_pid} — queued for retry`);
    } else {
      logger.warn(`[notifyd] retry queue full (${RETRY_CAP}) — dropping edge for parent ${stored.parent_pid}`);
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
      return {
        pid: o.pid,
        started_at: o.started_at,
        ts: o.ts,
        token: typeof o.token === "string" ? o.token : null,
      };
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

/**
 * Cooperatively request the running daemon to stop, NON-DESTRUCTIVELY: remove its
 * lock rather than SIGTERM-ing the pid. The daemon checks its owner token every
 * tick and exits when the lock is gone, so a pid recycled onto an unrelated
 * process is never signalled. Returns the daemon's pid if one was running, else
 * null. (A wedged daemon that isn't ticking relies on OS/self-exit — a residual
 * tracked in the follow-up issue.)
 */
export async function requestDaemonStop(): Promise<number | null> {
  const id = await daemonIdentity();
  if (!id || id.token === null) return null;
  // Re-read the owner token right before removing the lock and compare it to the
  // token we VALIDATED above (this incarnation's). If daemon A validated, then
  // exited, and B took over before the rm, the current token is B's — different
  // from A's — so we do NOT remove B's lock (which would stop the new daemon).
  // The residual re-read→rm window is the unavoidable FS-single-CAS gap (bounded).
  const cur = await readDaemonOwnerToken();
  if (cur !== id.token) return null;
  await rm(daemonLockDir(), { recursive: true, force: true }).catch(() => {});
  return id.pid;
}

/** Ensure a daemon is running; best-effort spawn detached. Returns its pid or null. */
export async function ensureDaemon(): Promise<number | null> {
  const existing = await daemonStatus();
  if (existing) return existing;
  const { spawn } = await import("node:child_process");
  // Resolve our own launcher the way serve/schedule/restart do: on POSIX `ay` is
  // a `#!/usr/bin/env bun` script (run via process.execPath), on Windows it's a
  // self-contained ay.exe. Fall back to THIS process's own script path
  // (process.argv[1]) — which is always present — rather than a bare `ay` that a
  // minimal PATH / absolute-path launch wouldn't resolve.
  const ayBin = Bun.which("ay") ?? process.argv[1];
  if (!ayBin) return null;
  const launcher = process.platform === "win32" ? [ayBin] : [process.execPath, ayBin];
  const [cmd, ...pre] = launcher;
  const child = spawn(cmd!, [...pre, "notifyd", "run"], {
    detached: true,
    stdio: "ignore",
  });
  // spawn's ENOENT surfaces ASYNC as an 'error' event — without a handler it
  // crashes the process. Swallow it; the daemonStatus() check below reports the
  // real outcome (null if the spawn didn't come up).
  child.on("error", () => {});
  child.unref();
  // Poll for the daemon to come up with a bounded φ-backoff (golden-ratio, the
  // repo convention) instead of a single fixed wait — a cold `bun` start or slow
  // FS can take longer than any one fixed delay, so a fixed wait falsely reports
  // "failed". Early-return the moment it's up; give up after a bounded total.
  const PHI = 1.618;
  let delay = 50;
  let waited = 0;
  const BUDGET_MS = 3000;
  for (;;) {
    await new Promise((r) => setTimeout(r, delay));
    waited += delay;
    const pid = await daemonStatus();
    if (pid) return pid;
    if (waited >= BUDGET_MS) return null;
    delay = Math.min(Math.round(delay * PHI), 800);
  }
}
