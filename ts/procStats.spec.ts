import { describe, expect, it } from "vitest";
import {
  buildChildIndex,
  derivePageSize,
  descendantsOf,
  humanBytes,
  parseMeminfo,
  parseProcStat,
  parsePsTable,
  parsePsTime,
  sampleTrees,
  snapshotProcs,
  systemStats,
  type ProcSample,
} from "./procStats.ts";

/**
 * Build the post-comm portion of a /proc/<pid>/stat line. Fields 3.. are:
 * state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt
 * utime stime cutime cstime priority nice num_threads itrealvalue starttime
 * vsize rss — so state=0, ppid=1, utime=11, stime=12, starttime=19, rss=21.
 */
function statLine(opts: {
  pid: number;
  ppid: number;
  utime?: number;
  stime?: number;
  rssPages?: number;
  state?: string;
  comm?: string;
  startTime?: string;
}): string {
  const f = Array(22).fill("0");
  f[0] = opts.state ?? "S";
  f[1] = String(opts.ppid);
  f[11] = String(opts.utime ?? 0);
  f[12] = String(opts.stime ?? 0);
  f[19] = opts.startTime ?? "5000";
  f[21] = String(opts.rssPages ?? 0);
  return `${opts.pid} (${opts.comm ?? "claude"}) ${f.join(" ")}`;
}

describe("parseProcStat", () => {
  it("reads ppid, cpu and rss from a normal stat line", () => {
    const s = parseProcStat(
      42,
      statLine({ pid: 42, ppid: 7, utime: 150, stime: 50, rssPages: 10 }),
    );
    expect(s).toEqual({
      pid: 42,
      ppid: 7,
      rss: 10 * 4096,
      cpuSeconds: 2, // (150 + 50) ticks / 100 USER_HZ
      state: "S",
      startToken: "5000",
    });
  });

  it("scales rss by the measured page size, not a hardcoded 4 KiB", () => {
    const s = parseProcStat(1, statLine({ pid: 1, ppid: 0, rssPages: 10 }), 16384);
    expect(s?.rss).toBe(10 * 16384);
  });

  it("survives a comm containing spaces and parentheses", () => {
    // The reason we parse after the LAST ')': naive splitting mis-indexes every
    // field past the comm.
    const s = parseProcStat(9, statLine({ pid: 9, ppid: 3, comm: "my prog (v2)", rssPages: 2 }));
    expect(s?.ppid).toBe(3);
    expect(s?.rss).toBe(2 * 4096);
  });

  it("returns null on a line with no comm terminator", () => {
    expect(parseProcStat(1, "garbage without paren")).toBeNull();
  });

  it("returns null when the numeric fields are unparseable", () => {
    expect(parseProcStat(1, "1 (x) S notanumber")).toBeNull();
  });
});

describe("parsePsTime", () => {
  it("parses mm:ss", () => {
    expect(parsePsTime("01:30")).toBe(90);
  });
  it("parses hh:mm:ss", () => {
    expect(parsePsTime("02:00:00")).toBe(7200);
  });
  it("parses dd-hh:mm:ss", () => {
    expect(parsePsTime("1-00:00:00")).toBe(86400);
  });
  it("returns 0 for junk", () => {
    expect(parsePsTime("-")).toBe(0);
  });
});

describe("parsePsTable", () => {
  it("normalizes ps KiB into bytes so both backends agree", () => {
    const procs = parsePsTable("  10  1  2048  00:10 S\n  11 10   512  00:00 Z\n");
    expect(procs.get(10)).toEqual({
      pid: 10,
      ppid: 1,
      rss: 2048 * 1024,
      cpuSeconds: 10,
      state: "S",
      // No usable start token from `ps` — the pid-reuse guard is Linux-only.
      startToken: "",
    });
    expect(procs.get(11)?.state).toBe("Z");
  });

  it("skips short/garbage lines", () => {
    expect(parsePsTable("\nnonsense\n  1 2 3 4 S\n").size).toBe(1);
  });
});

describe("descendantsOf", () => {
  const procs = new Map<number, ProcSample>(
    (
      [
        [1, 0],
        [10, 1],
        [11, 10],
        [12, 11], // depth 3 under 10
        [20, 1],
      ] as [number, number][]
    ).map(([pid, ppid]) => [
      pid,
      { pid, ppid, rss: 0, cpuSeconds: 0, state: "S", startToken: `t${pid}` },
    ]),
  );
  const kids = buildChildIndex(procs);

  it("walks the FULL closure, not just direct children", () => {
    expect([...descendantsOf(10, kids)].sort((a, b) => a - b)).toEqual([10, 11, 12]);
  });

  it("excludes pids already claimed by an earlier root", () => {
    expect([...descendantsOf(10, kids, new Set([11]))].sort((a, b) => a - b)).toEqual([10]);
  });

  it("terminates on a parent cycle instead of blowing the stack", () => {
    const cyclic = new Map<number, ProcSample>([
      [1, { pid: 1, ppid: 2, rss: 0, cpuSeconds: 0, state: "S", startToken: "t1" }],
      [2, { pid: 2, ppid: 1, rss: 0, cpuSeconds: 0, state: "S", startToken: "t2" }],
    ]);
    expect(descendantsOf(1, buildChildIndex(cyclic)).size).toBe(2);
  });
});

/** Two scripted /proc snapshots, returned on successive calls. */
function scriptedDeps(rounds: string[][]) {
  let call = 0;
  const pidsOf = (lines: string[]) => lines.map((l) => Number(l.split(" ")[0]));
  return {
    platform: "linux",
    listPids: async () => {
      const r = rounds[Math.min(call, rounds.length - 1)] as string[];
      return pidsOf(r);
    },
    readStat: async (pid: number) => {
      const r = rounds[Math.min(call, rounds.length - 1)] as string[];
      const hit = r.find((l) => Number(l.split(" ")[0]) === pid) ?? null;
      // Advance only after the last pid of a round has been read.
      if (pid === pidsOf(r)[r.length - 1]) call++;
      return hit;
    },
  };
}

describe("sampleTrees", () => {
  it("rolls a subtree up and derives CPU% from the delta, not lifetime total", async () => {
    // Root 10 has child 11. Between samples the pair burns 0.5s of CPU over a
    // 0.5s window => 100% of one core, even though lifetime CPU is far larger.
    const first = [
      statLine({ pid: 10, ppid: 1, utime: 10000, rssPages: 100 }),
      statLine({ pid: 11, ppid: 10, utime: 10000, rssPages: 100 }),
    ];
    const second = [
      statLine({ pid: 10, ppid: 1, utime: 10025, rssPages: 100 }),
      statLine({ pid: 11, ppid: 10, utime: 10025, rssPages: 100 }),
    ];
    const { trees } = await sampleTrees([10], {
      windowMs: 500,
      deps: scriptedDeps([first, second]),
    });
    const t = trees.get(10);
    expect(t?.procs).toBe(2);
    expect(t?.rss).toBe(200 * 4096);
    // 0.5 CPU-seconds over ~0.5s wall. Generous bound: the sleep can overshoot
    // on a loaded box, which only ever lowers the percentage.
    expect(t?.cpuPercent).toBeGreaterThan(60);
    expect(t?.cpuPercent).toBeLessThanOrEqual(110);
  });

  it("does not credit a process that appeared mid-window with its whole history", async () => {
    // 11 shows up only in the second sample carrying 100s of cumulative CPU.
    // Counting that would spike the row to nonsense.
    const first = [statLine({ pid: 10, ppid: 1 })];
    const second = [statLine({ pid: 10, ppid: 1 }), statLine({ pid: 11, ppid: 10, utime: 10000 })];
    const { trees } = await sampleTrees([10], {
      windowMs: 100,
      deps: scriptedDeps([first, second]),
    });
    expect(trees.get(10)?.procs).toBe(2);
    expect(trees.get(10)?.cpuPercent).toBe(0);
  });

  it("ignores the baseline when a pid was REUSED between samples", async () => {
    // Same pid, different process (start time changed) carrying a much smaller
    // counter. Subtracting across the two is meaningless; Math.max would clamp
    // to 0 here, but the reverse case (reused pid with a LARGER counter) would
    // otherwise report a huge bogus spike.
    const first = [statLine({ pid: 10, ppid: 1, utime: 100, startTime: "1000" })];
    const second = [statLine({ pid: 10, ppid: 1, utime: 9999, startTime: "8888" })];
    const { trees } = await sampleTrees([10], {
      windowMs: 100,
      deps: scriptedDeps([first, second]),
    });
    expect(trees.get(10)?.cpuPercent).toBe(0);
  });

  it("still uses the baseline when the start token is unavailable", async () => {
    // The ps fallback yields "" for both samples — "no opinion" must not be
    // treated as a mismatch, or CPU% would be permanently 0 off Linux.
    let call = 0;
    const deps = {
      platform: "darwin",
      readPsTable: async () => (call++ === 0 ? "10 1 100 00:00 S\n" : "10 1 100 00:01 S\n"),
    };
    const { trees } = await sampleTrees([10], { windowMs: 100, deps });
    expect(trees.get(10)?.cpuPercent).toBeGreaterThan(0);
  });

  it("gives a nested root its own subtree when claimed deepest-first", async () => {
    // 10 -> 11 -> 12, with both 10 and 11 listed as agent roots.
    const snap = [
      statLine({ pid: 10, ppid: 1, rssPages: 10 }),
      statLine({ pid: 11, ppid: 10, rssPages: 10 }),
      statLine({ pid: 12, ppid: 11, rssPages: 10 }),
    ];
    const { trees } = await sampleTrees([11, 10], {
      windowMs: 100,
      deps: scriptedDeps([snap, snap]),
    });
    // Child claims 11+12; parent keeps only itself — no double counting, and
    // crucially the child is not rendered as an empty 0-proc row.
    expect(trees.get(11)?.procs).toBe(2);
    expect(trees.get(10)?.procs).toBe(1);
  });

  it("reports everything unclaimed as the unattributed row", async () => {
    const snap = [
      statLine({ pid: 10, ppid: 1, rssPages: 10 }),
      statLine({ pid: 99, ppid: 1, rssPages: 5 }),
    ];
    const { unattributed } = await sampleTrees([10], {
      windowMs: 100,
      deps: scriptedDeps([snap, snap]),
    });
    expect(unattributed.procs).toBe(1);
    expect(unattributed.rss).toBe(5 * 4096);
  });
});

describe("snapshotProcs", () => {
  it("skips pids that vanish between listing and reading", async () => {
    const procs = await snapshotProcs({
      platform: "linux",
      listPids: async () => [1, 2],
      readStat: async (pid) => (pid === 1 ? statLine({ pid: 1, ppid: 0 }) : null),
    });
    expect([...procs.keys()]).toEqual([1]);
  });

  it("falls back to the ps table off Linux", async () => {
    const procs = await snapshotProcs({
      platform: "darwin",
      readPsTable: async () => "  5  1  1024  00:02 S\n",
    });
    expect(procs.get(5)?.rss).toBe(1024 * 1024);
  });
});

describe("derivePageSize", () => {
  it("recovers a 16 KiB page size from our own VmRSS vs rss-in-pages", () => {
    // 100 pages reported as 1600 kB => 16384 bytes per page.
    expect(derivePageSize(statLine({ pid: 1, ppid: 0, rssPages: 100 }), "VmRSS:  1600 kB")).toBe(
      16384,
    );
  });

  it("recovers the ordinary 4 KiB case", () => {
    expect(derivePageSize(statLine({ pid: 1, ppid: 0, rssPages: 100 }), "VmRSS:   400 kB")).toBe(
      4096,
    );
  });

  it("falls back to 4 KiB when either side is missing or zero", () => {
    expect(derivePageSize(statLine({ pid: 1, ppid: 0, rssPages: 0 }), "VmRSS: 400 kB")).toBe(4096);
    expect(derivePageSize(statLine({ pid: 1, ppid: 0, rssPages: 100 }), "no vmrss here")).toBe(
      4096,
    );
    expect(derivePageSize("garbage", "VmRSS: 400 kB")).toBe(4096);
  });
});

describe("parseMeminfo", () => {
  it("converts kB entries to bytes", () => {
    const m = parseMeminfo("MemTotal:       16316360 kB\nMemAvailable:    2500000 kB\n");
    expect(m.get("MemTotal")).toBe(16316360 * 1024);
    expect(m.get("MemAvailable")).toBe(2500000 * 1024);
  });
});

describe("systemStats", () => {
  it("reads load/mem and counts zombies from the snapshot", async () => {
    const procs = new Map<number, ProcSample>([
      [1, { pid: 1, ppid: 0, rss: 0, cpuSeconds: 0, state: "S", startToken: "t1" }],
      [2, { pid: 2, ppid: 1, rss: 0, cpuSeconds: 0, state: "Z", startToken: "t2" }],
      [3, { pid: 3, ppid: 1, rss: 0, cpuSeconds: 0, state: "Z", startToken: "t3" }],
    ]);
    const sys = await systemStats(procs, {
      readSys: async (name) =>
        name === "loadavg"
          ? "15.23 12.52 9.86 5/2000 12345\n"
          : "MemTotal: 100 kB\nMemAvailable: 40 kB\nSwapTotal: 50 kB\nSwapFree: 0 kB\n",
    });
    expect(sys.load).toEqual([15.23, 12.52, 9.86]);
    expect(sys.zombies).toBe(2);
    expect(sys.memAvailableBytes).toBe(40 * 1024);
    expect(sys.swapFreeBytes).toBe(0);
  });

  it("falls back to node:os when /proc is unreadable, so the header is not blank", async () => {
    // Off Linux there is no /proc at all; without this fallback macOS/BSD would
    // render an empty system line.
    const sys = await systemStats(new Map(), { readSys: async () => null });
    expect(sys.memTotalBytes).toBeGreaterThan(0);
    expect(sys.memAvailableBytes).toBeGreaterThan(0);
    // node:os has no swap breakdown — that stays unknown rather than guessed.
    expect(sys.swapTotalBytes).toBeNull();
    if (process.platform !== "win32") expect(sys.load).not.toBeNull();
  });
});

describe("humanBytes", () => {
  it("keeps a decimal below 100 so Gi totals match free -h", () => {
    expect(humanBytes(15.6 * 1024 ** 3)).toBe("15.6Gi");
  });
  it("rounds at three significant digits", () => {
    expect(humanBytes(376 * 1024 ** 2)).toBe("376Mi");
  });
  it("renders unknown as a dash", () => {
    expect(humanBytes(null)).toBe("-");
  });
});

describe("real host adapters", () => {
  // Every other test here injects fake readers, so the DEFAULT ones — /proc on
  // Linux, the `ps` fallback everywhere else — were never executed. These call
  // them for real: read-only, and the only check that the adapters actually work
  // on the machine the code ships to.
  it("snapshotProcs sees this very process on the real host", async () => {
    const procs = await snapshotProcs();
    expect(procs.size).toBeGreaterThan(0);
    const self = procs.get(process.pid);
    expect(self).toBeDefined();
    expect(self!.rss).toBeGreaterThan(0);
  });

  it("systemStats reads the box vitals on the real host", async () => {
    const sys = await systemStats(await snapshotProcs());
    // load is unavailable on some sandboxes; memory should always be readable.
    expect(sys.memTotalBytes === null || sys.memTotalBytes > 0).toBe(true);
    expect(sys.ncpu === null || sys.ncpu > 0).toBe(true);
    expect(sys.zombies).toBeGreaterThanOrEqual(0);
  });

  it("sampleTrees attributes this process's own tree", async () => {
    const { trees, unattributed } = await sampleTrees([process.pid], { windowMs: 100 });
    const mine = trees.get(process.pid);
    expect(mine).toBeDefined();
    expect(mine!.procs).toBeGreaterThanOrEqual(1);
    expect(unattributed.procs).toBeGreaterThanOrEqual(0);
  });
});
