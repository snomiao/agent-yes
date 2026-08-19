/**
 * Periodic per-agent resource sampler for the console heatmaps — the TS twin of
 * `rs/src/serve/sampler.rs` (see there for the shared design). The Rust daemon
 * ships this already; this port lets the TS `ay serve` daemon — which is what
 * actually serves the browser console — expose the SAME `res` / `resources`
 * fields, so the console renders identically whichever host backs it.
 *
 * Reuses `ts/procStats.ts` (the `ay ps` machinery) for one full process-tree
 * snapshot + rollup per sweep, bucketed into a per-agent rolling window.
 * Best-effort throughout — a failed snapshot, an agent exited mid-sweep, or a
 * non-/proc platform all degrade to "no data" (transparent) rather than breaking
 * the serve path.
 *
 * Adaptive granularity (same rule as Rust):
 *   pass time <  1s  →  bucket =  60s, window = 60 buckets  (1h)
 *   pass time >= 1s  →  bucket = 300s, window = 12 buckets  (1h)
 */

import { sampleTrees, type TreeStats } from "./procStats.ts";

const BUCKET_FAST_SECS = 60;
const BUCKET_SLOW_SECS = 300;
const WINDOW_FAST = 60; // 1h @ 1m buckets
const WINDOW_SLOW = 12; // 1h @ 5m buckets
const PASS_THRESHOLD_MS = 1000;
// CPU is a live delta; a short window keeps each sweep's sample "instantaneous"
// so we're not averaging a whole minute's CPU into one number.
const SWEEP_WINDOW_MS = 120;

/** One bucketed per-agent sample (one point on the heatmap). */
export interface Bucket {
  /** CPU seconds of ONE core consumed over the sweep window (≈ instantaneous). */
  cpu_seconds: number;
  /** RSS (bytes) snapshot at bucket close. */
  rss: number;
  /** Live process count at bucket close. */
  procs: number;
}

/** Snapshot handed to /api/ls (`res`) and /api/host (`resources`). */
export interface ResSnapshot {
  /** wrapper pid → resource window (oldest first), each (unix_ms, bucket). */
  agents: Map<number, Array<[number, Bucket]>>;
  /** The unattributed (non-agent-yes) rollup at the last sweep. */
  unattributed: Bucket;
  /** Bucket width actually in use (60 or 300), for the console's axis label. */
  bucketSecs: number;
}

interface State {
  snap: ResSnapshot;
  bucketSecs: number;
}

function windowLen(bucketSecs: number): number {
  return bucketSecs <= BUCKET_FAST_SECS ? WINDOW_FAST : WINDOW_SLOW;
}

function bucketOf(t: TreeStats, elapsedSeconds: number): Bucket {
  return {
    // cpuPercent is percent of ONE core over the sample window → convert to
    // seconds-of-one-core by ×(elapsed/100). (matches Rust's cpu_delta semantics)
    cpu_seconds: (t.cpuPercent / 100) * elapsedSeconds,
    rss: t.rss,
    procs: t.procs,
  };
}

const state: State = {
  snap: { agents: new Map(), unattributed: { cpu_seconds: 0, rss: 0, procs: 0 }, bucketSecs: 0 },
  bucketSecs: 0,
};

function getSnapshot(): ResSnapshot {
  return state.snap;
}

/**
 * The per-agent resource window as the console's `entry.res` field (matching the
 * Rust `/api/ls` `res` shape exactly): { bucket_secs, t[], cpu_seconds[], rss[],
 * procs[] }. Null when the sampler has not yet recorded this agent.
 */
function resField(pid: number): {
  bucket_secs: number;
  t: number[];
  cpu_seconds: number[];
  rss: number[];
  procs: number[];
} | null {
  const series = state.snap.agents.get(pid);
  if (!series || series.length === 0) return null;
  return {
    bucket_secs: state.snap.bucketSecs,
    t: series.map(([t]) => t),
    cpu_seconds: series.map(([, b]) => b.cpu_seconds),
    rss: series.map(([, b]) => b.rss),
    procs: series.map(([, b]) => b.procs),
  };
}

/** The managed/unattributed split for the room line, matching the Rust shape. */
function resourcesField(): {
  bucket_secs: number;
  managed_rss: number;
  managed_procs: number;
  unattributed_rss: number;
  unattributed_procs: number;
} {
  let managedRss = 0;
  let managedProcs = 0;
  for (const series of state.snap.agents.values()) {
    const last = series[series.length - 1];
    if (last) {
      managedRss += last[1].rss;
      managedProcs += last[1].procs;
    }
  }
  return {
    bucket_secs: state.snap.bucketSecs,
    managed_rss: managedRss,
    managed_procs: managedProcs,
    unattributed_rss: state.snap.unattributed.rss,
    unattributed_procs: state.snap.unattributed.procs,
  };
}

function getBucketSecs(): number {
  return state.bucketSecs;
}

/**
 * Run one sweep against the given live root pids and bucket the result. Exposed so
 * `serve.ts` drives it with its own notion of the live fleet (it already has
 * `listRecords`). Returns the chosen bucket width (after the adaptive first pass).
 */
async function sweep(roots: number[]): Promise<number> {
  if (roots.length === 0) {
    // Nothing to sample — still mark the width as chosen so the timer uses a
    // sane cadence, and refresh the empty snapshot.
    if (state.bucketSecs === 0) state.bucketSecs = BUCKET_FAST_SECS;
    state.snap.bucketSecs = state.bucketSecs;
    return state.bucketSecs;
  }

  const start = Date.now();
  let result: Awaited<ReturnType<typeof sampleTrees>>;
  try {
    // Deepest-first, like `ay ps`: a nested agent must claim its subtree before
    // its parent walks through it (sampleTrees attributes first-come).
    result = await sampleTrees([...roots].reverse(), { windowMs: SWEEP_WINDOW_MS });
  } catch {
    return state.bucketSecs || BUCKET_FAST_SECS; // keep last snapshot
  }
  const pass = Date.now() - start;

  if (state.bucketSecs === 0) {
    // First pass timed → pick the bucket width.
    state.bucketSecs = pass < PASS_THRESHOLD_MS ? BUCKET_FAST_SECS : BUCKET_SLOW_SECS;
  }

  const now = Date.now();
  const max = windowLen(state.bucketSecs);
  const elapsedSeconds = Math.max(0.001, pass / 1000);

  for (const [pid, stats] of result.trees) {
    const series = state.snap.agents.get(pid) ?? [];
    series.push([now, bucketOf(stats, elapsedSeconds)]);
    if (series.length > max) series.splice(0, series.length - max);
    state.snap.agents.set(pid, series);
  }
  const un = result.unattributed;
  state.snap.unattributed = {
    cpu_seconds: (un.cpuPercent / 100) * elapsedSeconds,
    rss: un.rss,
    procs: un.procs,
  };
  state.snap.bucketSecs = state.bucketSecs;

  return state.bucketSecs;
}

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Start the background sampler. Idempotent. `serve.ts` calls this once on startup;
 * `getRoots` returns the live wrapper pids (it already reads them via listRecords).
 * Self-schedules with setTimeout so the adaptive bucket width takes effect on the
 * very next tick without interval re-arm gymnastics.
 */
function startSampler(getRoots: () => Promise<number[]>): void {
  if (started) return;
  started = true;

  const tick = async () => {
    let width = state.bucketSecs || BUCKET_FAST_SECS;
    try {
      const roots = await getRoots();
      width = (await sweep(roots)) || width;
    } catch {
      /* best-effort */
    }
    if (!started) return;
    timer = setTimeout(tick, width * 1000);
    (timer as unknown as { unref?: () => void }).unref?.();
  };

  // Prime immediately (first bucket lands before the first list poll), then loop.
  void tick();
}

function stopSampler(): void {
  started = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

export { getSnapshot, getBucketSecs, resField, resourcesField, startSampler, stopSampler, sweep, windowLen };
