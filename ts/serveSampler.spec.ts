import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The sampler's only outside dependency is one `sampleTrees` call per sweep, so
// mocking it here lets every branch below run against synthetic process trees —
// no /proc, no live fleet, and identical behaviour on macOS and Linux CI.
const sampleTrees = vi.fn();
vi.mock("./procStats.ts", () => ({
  sampleTrees: (...args: unknown[]) => sampleTrees(...args),
}));

import {
  getBucketSecs,
  getSnapshot,
  resField,
  resourcesField,
  startSampler,
  stopSampler,
  sweep,
  windowLen,
} from "./serveSampler.ts";

/** A TreeStats literal — the shape sampleTrees hands back per root pid. */
function tree(pid: number, rss: number, cpuPercent: number, procs: number) {
  return { pid, rss, cpuPercent, procs };
}

/** A whole sampleTrees result: the given trees plus an unattributed rollup. */
function result(trees: Array<ReturnType<typeof tree>>, unattributed = tree(0, 0, 0, 0)) {
  return {
    trees: new Map(trees.map((t) => [t.pid, t])),
    unattributed,
    claimed: new Map(),
  };
}

// The sampler keeps its window in module-level state (one sampler per daemon),
// so each test starts from a known-empty snapshot rather than inheriting the
// previous test's buckets.
function resetState() {
  stopSampler();
  const snap = getSnapshot();
  snap.agents.clear();
  snap.unattributed = { cpu_seconds: 0, rss: 0, procs: 0 };
  snap.bucketSecs = 0;
  // getBucketSecs() reads the same private width `sweep` sets; drive it back to
  // the unchosen state through the public path (an empty sweep re-primes it).
}

beforeEach(() => {
  sampleTrees.mockReset();
  resetState();
});

afterEach(() => {
  stopSampler();
  vi.useRealTimers();
});

describe("windowLen", () => {
  it("tracks the adaptive bucket width", () => {
    expect(windowLen(60)).toBe(60); // fast: 1m buckets, 1h window
    expect(windowLen(300)).toBe(12); // slow: 5m buckets, 1h window
    expect(windowLen(1)).toBe(60); // anything ≤60 counts as fast
  });
});

describe("sweep", () => {
  it("with no live roots still settles a bucket width without sampling", async () => {
    const width = await sweep([]);
    expect(width).toBeGreaterThan(0);
    expect([60, 300]).toContain(width);
    // No roots means there is nothing to snapshot — the expensive process walk
    // must be skipped entirely, not called with an empty list.
    expect(sampleTrees).not.toHaveBeenCalled();
    expect(getSnapshot().bucketSecs).toBe(width);
  });

  it("keeps the already-chosen width when a later sweep finds no roots", async () => {
    sampleTrees.mockResolvedValueOnce(result([tree(100, 1, 0, 1)]));
    const chosen = await sweep([100]);

    // The whole fleet exiting must not re-open the width decision: the console's
    // axis label would jump under it mid-session.
    expect(await sweep([])).toBe(chosen);
    expect(getSnapshot().bucketSecs).toBe(chosen);
  });

  it("records one bucket per sampled agent and the unattributed rollup", async () => {
    sampleTrees.mockResolvedValue(
      result([tree(100, 2048, 50, 3), tree(200, 4096, 10, 1)], tree(0, 8192, 20, 9)),
    );

    await sweep([100, 200]);

    const snap = getSnapshot();
    expect([...snap.agents.keys()].sort()).toEqual([100, 200]);
    expect(snap.agents.get(100)).toHaveLength(1);
    expect(snap.agents.get(100)![0]![1].rss).toBe(2048);
    expect(snap.agents.get(100)![0]![1].procs).toBe(3);
    expect(snap.unattributed.rss).toBe(8192);
    expect(snap.unattributed.procs).toBe(9);
  });

  it("walks roots deepest-first so a nested agent claims its subtree before its parent", async () => {
    sampleTrees.mockResolvedValue(result([tree(100, 1, 0, 1)]));

    await sweep([100, 200, 300]);

    // `ay ps` semantics: sampleTrees attributes first-come, so the caller must
    // hand it the reversed list. Getting this backwards silently credits a
    // child's memory to its parent.
    expect(sampleTrees.mock.calls[0]![0]).toEqual([300, 200, 100]);
  });

  it("converts cpuPercent into cpu-seconds of one core over the pass", async () => {
    sampleTrees.mockResolvedValue(result([tree(100, 0, 100, 1)], tree(0, 0, 50, 1)));

    await sweep([100]);

    // 100% of one core is at most the pass duration in seconds, and the floor on
    // elapsed (1ms) keeps a sub-millisecond pass from producing a huge number.
    const cpu = getSnapshot().agents.get(100)![0]![1].cpu_seconds;
    expect(cpu).toBeGreaterThan(0);
    expect(cpu).toBeLessThan(1);
    // The unattributed rollup goes through the same conversion, at half the rate.
    expect(getSnapshot().unattributed.cpu_seconds).toBeCloseTo(cpu / 2, 10);
  });

  it("keeps the last good snapshot when a sweep throws", async () => {
    sampleTrees.mockResolvedValueOnce(result([tree(100, 4096, 0, 2)]));
    await sweep([100]);
    const width = getBucketSecs();

    sampleTrees.mockRejectedValueOnce(new Error("/proc vanished"));
    const after = await sweep([100]);

    // Best-effort: a failed snapshot degrades to "no new data", never to a
    // cleared window (which the console would render as the agent dying).
    expect(after).toBe(width);
    expect(getSnapshot().agents.get(100)).toHaveLength(1);
    expect(getSnapshot().agents.get(100)![0]![1].rss).toBe(4096);
  });

  it("falls back to the fast width when the very first sweep throws", async () => {
    sampleTrees.mockRejectedValueOnce(new Error("boom"));
    // Width was never chosen (state.bucketSecs === 0), so the catch path has no
    // previous value to keep and must still return a usable cadence.
    expect(await sweep([100])).toBe(60);
  });

  it("picks the slow bucket width when the first pass is slow", async () => {
    // The width is chosen ONCE, on the first timed pass, and then sticks for the
    // life of the daemon — so this needs a module instance no earlier test has
    // already driven to the fast width.
    vi.resetModules();
    const fresh = await import("./serveSampler.ts");

    // sweep() times its own pass with Date.now(), so stub the clock to report a
    // pass over the 1s threshold rather than actually sleeping for one.
    let now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    sampleTrees.mockImplementationOnce(async () => {
      now += 1500; // pass >= 1s → 5m buckets
      return result([tree(100, 1, 0, 1)]);
    });

    try {
      expect(await fresh.sweep([100])).toBe(300);
      expect(fresh.getBucketSecs()).toBe(300);
      // 5m buckets ⇒ a 12-slot window, so an hour of history still fits.
      expect(fresh.windowLen(300)).toBe(12);
    } finally {
      nowSpy.mockRestore();
      fresh.stopSampler();
    }
  });

  it("trims the rolling window to the bucket count and keeps the newest samples", async () => {
    // Force the fast width (60 buckets) with a fast first pass, then overfill.
    for (let i = 0; i < 63; i++) {
      sampleTrees.mockResolvedValueOnce(result([tree(100, i, 0, 1)]));
      await sweep([100]);
    }

    const series = getSnapshot().agents.get(100)!;
    expect(series).toHaveLength(windowLen(60));
    // Oldest-first ordering, with the three oldest dropped — the console draws
    // left-to-right, so a reversed window would render the heatmap backwards.
    expect(series[0]![1].rss).toBe(3);
    expect(series[series.length - 1]![1].rss).toBe(62);
  });
});

describe("resField", () => {
  it("is null for an agent the sampler has not recorded", async () => {
    sampleTrees.mockResolvedValue(result([tree(100, 1, 0, 1)]));
    await sweep([100]);

    expect(resField(999)).toBeNull();
  });

  it("transposes the window into the parallel arrays /api/ls expects", async () => {
    sampleTrees.mockResolvedValueOnce(result([tree(100, 10, 0, 1)]));
    await sweep([100]);
    sampleTrees.mockResolvedValueOnce(result([tree(100, 20, 0, 2)]));
    await sweep([100]);

    const field = resField(100)!;
    // Byte-compatible with the Rust /api/ls shape: one array per metric, all the
    // same length, sharing the `t` index.
    expect(field.bucket_secs).toBe(getSnapshot().bucketSecs);
    expect(field.rss).toEqual([10, 20]);
    expect(field.procs).toEqual([1, 2]);
    expect(field.t).toHaveLength(2);
    expect(field.cpu_seconds).toHaveLength(2);
  });
});

describe("resourcesField", () => {
  it("reports zeroes before the first sweep", () => {
    const f = resourcesField();
    expect(f.managed_rss).toBe(0);
    expect(f.managed_procs).toBe(0);
    expect(f.unattributed_rss).toBe(0);
  });

  it("skips an agent whose window is empty rather than counting a missing bucket", async () => {
    sampleTrees.mockResolvedValueOnce(result([tree(100, 1000, 0, 2)]));
    await sweep([100]);
    // An agent registered with no samples yet (its series trimmed to nothing) must
    // contribute zero, not throw on the absent last bucket.
    getSnapshot().agents.set(777, []);

    const f = resourcesField();
    expect(f.managed_rss).toBe(1000);
    expect(f.managed_procs).toBe(2);
  });

  it("sums only the LAST bucket of each agent against the unattributed rollup", async () => {
    sampleTrees.mockResolvedValueOnce(
      result([tree(100, 1000, 0, 1), tree(200, 2000, 0, 2)], tree(0, 500, 0, 5)),
    );
    await sweep([100, 200]);
    // A second sweep must replace, not accumulate: summing every bucket in the
    // window would report an hour of history as current memory use.
    sampleTrees.mockResolvedValueOnce(
      result([tree(100, 1500, 0, 3), tree(200, 2500, 0, 4)], tree(0, 700, 0, 6)),
    );
    await sweep([100, 200]);

    const f = resourcesField();
    expect(f.managed_rss).toBe(4000); // 1500 + 2500, not 1000+2000+1500+2500
    expect(f.managed_procs).toBe(7); // 3 + 4
    expect(f.unattributed_rss).toBe(700);
    expect(f.unattributed_procs).toBe(6);
  });
});

describe("startSampler", () => {
  it("primes a sweep immediately and re-arms on the chosen width", async () => {
    vi.useFakeTimers();
    sampleTrees.mockResolvedValue(result([tree(100, 4096, 0, 1)]));

    startSampler(async () => [100]);
    await vi.advanceTimersByTimeAsync(0); // let the priming tick settle

    // The first bucket must land before the console's first list poll, so the
    // heatmap is never empty on a freshly started daemon.
    expect(getSnapshot().agents.get(100)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(getSnapshot().agents.get(100)!.length).toBeGreaterThan(1);
  });

  it("is idempotent — a second call does not start a second timer", async () => {
    vi.useFakeTimers();
    sampleTrees.mockResolvedValue(result([tree(100, 1, 0, 1)]));

    startSampler(async () => [100]);
    startSampler(async () => [100]);
    await vi.advanceTimersByTimeAsync(0);

    // Two timers would double every bucket and halve the effective window.
    expect(getSnapshot().agents.get(100)).toHaveLength(1);
  });

  it("survives a getRoots that throws", async () => {
    vi.useFakeTimers();
    startSampler(async () => {
      throw new Error("registry unreadable");
    });
    await vi.advanceTimersByTimeAsync(0);

    // Best-effort: the serve path must not fall over because the pid store was
    // momentarily unreadable — the loop keeps its cadence and tries again.
    expect(sampleTrees).not.toHaveBeenCalled();
    // The rejection is swallowed and the loop re-arms, so draining the next tick
    // must not surface an unhandled rejection.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sampleTrees).not.toHaveBeenCalled();
  });

  it("does not re-arm when stopped during an in-flight sweep", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    sampleTrees.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(result([tree(100, 1, 0, 1)]));
        }),
    );

    startSampler(async () => [100]);
    await vi.advanceTimersByTimeAsync(0);
    // Stop lands while the sweep is still awaiting: the tick must notice on
    // resume and NOT schedule another timer, else a stopped daemon keeps walking
    // /proc forever.
    stopSampler();
    release!();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(sampleTrees).toHaveBeenCalledTimes(1);
  });

  it("tolerates a timer handle with no unref (browser-shaped setTimeout)", async () => {
    vi.useFakeTimers();
    sampleTrees.mockResolvedValue(result([tree(100, 1, 0, 1)]));
    // Node hands back a Timeout carrying .unref(); a bare numeric handle (jsdom,
    // some bundlers) has none, and the optional call must simply skip it.
    const raw = globalThis.setTimeout;
    const stub = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      const h = raw(fn, ms);
      return { ...(h as object), unref: undefined } as unknown as ReturnType<typeof raw>;
    }) as typeof raw);

    try {
      startSampler(async () => [100]);
      await vi.advanceTimersByTimeAsync(0);
      expect(getSnapshot().agents.get(100)).toHaveLength(1);
    } finally {
      stub.mockRestore();
    }
  });

  it("uses the fast width for its first re-arm before any sweep has timed one", async () => {
    // A fresh instance has no chosen width yet, so the tick's own
    // `state.bucketSecs || BUCKET_FAST_SECS` fallback is what schedules the
    // second pass. Exercised here because the shared instance is always warm.
    vi.resetModules();
    const fresh = await import("./serveSampler.ts");
    vi.useFakeTimers();
    sampleTrees.mockResolvedValue(result([tree(100, 1, 0, 1)]));

    try {
      fresh.startSampler(async () => [100]);
      await vi.advanceTimersByTimeAsync(0);
      expect(sampleTrees).toHaveBeenCalledTimes(1);

      // 60s is the fast cadence; re-arming any slower would leave the console
      // without a second data point for five minutes.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sampleTrees).toHaveBeenCalledTimes(2);
    } finally {
      fresh.stopSampler();
    }
  });

  it("stopSampler halts the loop and allows a later restart", async () => {
    vi.useFakeTimers();
    sampleTrees.mockResolvedValue(result([tree(100, 1, 0, 1)]));

    startSampler(async () => [100]);
    await vi.advanceTimersByTimeAsync(0);
    const afterPrime = getSnapshot().agents.get(100)!.length;

    stopSampler();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(getSnapshot().agents.get(100)!.length).toBe(afterPrime);

    // `started` is cleared, so a restart primes again rather than no-opping.
    startSampler(async () => [100]);
    await vi.advanceTimersByTimeAsync(0);
    expect(getSnapshot().agents.get(100)!.length).toBeGreaterThan(afterPrime);
  });
});
