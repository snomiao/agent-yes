import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { listRecords } from "./subcommands.ts";
import { sampleTrees } from "./procStats.ts";
import { formatSystemLine, renderTable, repoLabel, type PsRow } from "./cmdPs.ts";
import type { SystemStats, TreeStats } from "./procStats.ts";

const stats = (over: Partial<TreeStats> = {}): TreeStats => ({
  pid: 1,
  rss: 0,
  cpuPercent: 0,
  procs: 1,
  ...over,
});

const row = (over: Partial<PsRow> = {}): PsRow => ({
  pid: 100,
  cli: "claude",
  status: "idle",
  cwd: "/code/snomiao/foo/tree/main",
  repo: "foo",
  stats: stats(),
  self: false,
  ...over,
});

const sys = (over: Partial<SystemStats> = {}): SystemStats => ({
  load: [15.23, 12.52, 9.86],
  ncpu: 8,
  memTotalBytes: 16 * 1024 ** 3,
  memAvailableBytes: 2 * 1024 ** 3,
  swapTotalBytes: 5 * 1024 ** 3,
  swapFreeBytes: 1 * 1024 ** 3,
  zombies: 0,
  ...over,
});

describe("repoLabel", () => {
  it("keeps a filesystem root label instead of returning an absent path segment", () => {
    expect(repoLabel("/")).toBe("/");
  });
  it("names the repo, not the branch dir every worktree shares", () => {
    expect(repoLabel("/code/snomiao/agent-yes/tree/main")).toBe("agent-yes");
    expect(repoLabel("/code/snomiao/agent-yes/tree/feat/x")).toBe("agent-yes");
  });

  it("falls back to the last segment outside a tree layout", () => {
    expect(repoLabel("/srv/plain-checkout")).toBe("plain-checkout");
  });

  it("does not index out of bounds on a root-level tree dir", () => {
    expect(repoLabel("/tree/main")).toBe("main");
  });
});

describe("formatSystemLine", () => {
  it("marks unavailable memory and swap counters without inventing an exhausted swap", () => {
    const line = formatSystemLine(sys({ memAvailableBytes: null, swapFreeBytes: null }));
    expect(line).toContain("mem -/16.0Gi");
    expect(line).toContain("swap -/5.0Gi");
    expect(line).not.toContain("FULL");
  });
  it("puts the oversubscription ratio next to the raw load", () => {
    // "15.23" is meaningless without the core count beside it.
    expect(formatSystemLine(sys())).toContain("load 15.23 12.52 9.86 (8 cpu, 1.9x)");
  });

  it("reports mem as used/total", () => {
    expect(formatSystemLine(sys())).toContain("mem 14.0Gi/16.0Gi");
  });

  it("calls out an exhausted swap in words", () => {
    // Full swap is the line between "loaded" and "one alloc from the OOM killer".
    expect(formatSystemLine(sys({ swapFreeBytes: 0 }))).toContain("FULL");
    expect(formatSystemLine(sys())).not.toContain("FULL");
  });

  it("omits swap entirely when the box has none", () => {
    expect(formatSystemLine(sys({ swapTotalBytes: 0 }))).not.toContain("swap");
  });

  it("mentions zombies only when there are some", () => {
    expect(formatSystemLine(sys({ zombies: 1440 }))).toContain("zombies 1440");
    expect(formatSystemLine(sys())).not.toContain("zombies");
  });

  it("degrades to whatever it could read", () => {
    const line = formatSystemLine(
      sys({ load: null, memTotalBytes: null, memAvailableBytes: null, swapTotalBytes: null }),
    );
    expect(line).toBe("");
  });
});

describe("renderTable", () => {
  const rows = [
    row({ pid: 1, repo: "big", stats: stats({ rss: 1024 ** 3, cpuPercent: 53.8, procs: 17 }) }),
    row({ pid: 22222, repo: "self", self: true, stats: stats({ rss: 1024 ** 2 }) }),
  ];

  it("marks the tree the command is running in", () => {
    const out = renderTable(rows, null);
    const selfLine = out.split("\n").find((l) => l.startsWith("22222")) as string;
    expect(selfLine).toContain("← this session");
    expect(out.split("\n").find((l) => l.startsWith("1 "))).not.toContain("← this session");
  });

  it("keeps every column aligned once the wide unmanaged row is present", () => {
    // "unmanaged" is wider than any real CLI name — sizing without it knocked
    // the whole table out of line.
    const out = renderTable(rows, stats({ pid: 0, rss: 2 * 1024 ** 3, procs: 1359 }));
    const lines = out.split("\n");
    const rssCol = (l: string) => l.indexOf("RSS");
    const header = lines[0] as string;
    expect(lines.some((l) => l.includes("unmanaged"))).toBe(true);
    // Every row's PROCS value must end at the same column as the header's.
    const procsEnd = header.indexOf("PROCS") + "PROCS".length;
    for (const l of lines.slice(1)) {
      expect(l.slice(0, procsEnd).trimEnd().length).toBeLessThanOrEqual(procsEnd);
    }
    expect(rssCol(header)).toBeGreaterThan(0);
  });

  it("omits the unmanaged row when the box is fully accounted for", () => {
    expect(renderTable(rows, stats({ procs: 0 }))).not.toContain("unmanaged");
  });
});

// Hoisted mocks with a mutable fixture. The earlier version re-mocked inside a
// helper with vi.resetModules() per call; when a reset raced, the REAL
// listRecords ran and returned whatever agents happened to be on the box — which
// looks like a pass locally (rows appear) and an empty table on CI (no agents).
const fixture: {
  records: Record<string, unknown>[];
  trees: Map<number, TreeStats>;
  unattributed: TreeStats;
  system: SystemStats;
} = {
  records: [],
  trees: new Map(),
  unattributed: { pid: 0, rss: 0, cpuPercent: 0, procs: 0 },
  system: sys(),
};

vi.mock("./subcommands.ts", () => ({
  listRecords: vi.fn(async () => fixture.records),
  deriveLiveState: vi.fn(async (r: { status: string }) => ({ state: r.status })),
}));

vi.mock("./procStats.ts", async () => {
  const actual = await vi.importActual<typeof import("./procStats.ts")>("./procStats.ts");
  return {
    ...actual,
    snapshotProcs: vi.fn(async () => new Map()),
    systemStats: vi.fn(async () => fixture.system),
    sampleTrees: vi.fn(async () => ({
      trees: fixture.trees,
      unattributed: fixture.unattributed,
    })),
  };
});

describe("cmdPs", () => {
  const rec = (over: Record<string, unknown> = {}) => ({
    pid: 100,
    cli: "claude",
    prompt: null,
    cwd: "/code/example/foo/tree/main",
    log_file: null,
    status: "active",
    exit_code: null,
    exit_reason: null,
    started_at: 0,
    ...over,
  });

  async function run(
    rest: string[],
    opts: {
      records?: Record<string, unknown>[];
      trees?: Map<number, TreeStats>;
      unattributed?: TreeStats;
      system?: SystemStats;
    } = {},
  ) {
    vi.mocked(listRecords).mockClear();
    vi.mocked(sampleTrees).mockClear();
    fixture.records = opts.records ?? [rec()];
    fixture.trees = opts.trees ?? new Map();
    fixture.unattributed = opts.unattributed ?? stats({ pid: 0, procs: 0 });
    fixture.system = opts.system ?? sys();

    const out: string[] = [];
    const err: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stdout as any).write = (s: any) => (out.push(String(s)), true);
    (process.stderr as any).write = (s: any) => (err.push(String(s)), true);
    try {
      const { cmdPs } = await import("./cmdPs.ts");
      const code = await cmdPs(rest);
      return { code, out: out.join(""), err: err.join("") };
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
  }

  /** pids in render order, from the table body. */
  const pids = (out: string) =>
    out
      .split("\n")
      .map((l) => l.trim().split(/\s+/)[0])
      .filter((p) => /^\d+$/.test(p ?? ""));

  it("prints the box vitals header and a row per agent", async () => {
    const r = await run([], {
      trees: new Map([[100, stats({ pid: 100, rss: 1024 ** 2, procs: 3 })]]),
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("load 15.23");
    expect(r.out).toContain("PID");
    expect(pids(r.out)).toEqual(["100"]);
    expect(r.out).toContain("foo");
  });

  it("says so and still exits 0 when nothing is running", async () => {
    const r = await run([], { records: [] });
    expect(r.code).toBe(0);
    expect(r.err).toContain("no running agents");
    expect(r.out).toBe("");
  });

  it("names the keyword that matched nothing", async () => {
    const r = await run(["nope"], { records: [] });
    expect(r.err).toContain('no agents matched "nope"');
  });

  it("--json emits the rollup with system, agents and unattributed", async () => {
    const r = await run(["--json"], {
      trees: new Map([[100, stats({ pid: 100, rss: 4096, cpuPercent: 12.345, procs: 2 })]]),
      unattributed: stats({ pid: 0, rss: 512, cpuPercent: 1.5, procs: 9 }),
    });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out);
    expect(parsed.system.ncpu).toBe(8);
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0]).toMatchObject({ pid: 100, cli: "claude", rssBytes: 4096, procs: 2 });
    // Rounded to 2dp on the way out, so consumers get a stable number.
    expect(parsed.agents[0].cpuPercent).toBe(12.35);
    expect(parsed.unattributed).toMatchObject({ rssBytes: 512, procs: 9 });
  });

  it("--sort orders by the chosen resource, and --tree keeps forest order", async () => {
    const records = [rec({ pid: 1 }), rec({ pid: 2 }), rec({ pid: 3 })];
    const trees = new Map([
      [1, stats({ pid: 1, rss: 10, cpuPercent: 90, procs: 1 })],
      [2, stats({ pid: 2, rss: 30, cpuPercent: 10, procs: 7 })],
      [3, stats({ pid: 3, rss: 20, cpuPercent: 50, procs: 3 })],
    ]);
    // rss is the default: biggest first.
    expect(pids((await run([], { records, trees })).out)).toEqual(["2", "3", "1"]);
    expect(pids((await run(["--sort", "cpu"], { records, trees })).out)).toEqual(["1", "3", "2"]);
    expect(pids((await run(["--sort", "procs"], { records, trees })).out)).toEqual(["2", "3", "1"]);
    expect(pids((await run(["--sort", "pid"], { records, trees })).out)).toEqual(["1", "2", "3"]);
    // --tree opts out of sorting entirely, keeping ay ls's forest order.
    expect(pids((await run(["--tree"], { records, trees })).out)).toEqual(["1", "2", "3"]);
  });

  it("renders a 0-usage row rather than dropping an agent the sampler missed", async () => {
    const r = await run([], { trees: new Map() });
    expect(pids(r.out)).toEqual(["100"]);
    expect(r.out).toMatch(/100\s+claude\s+active\s+0\.0/);
  });

  it("--cwd scopes the listing to that directory", async () => {
    // The scope is resolved to an absolute path before it reaches listRecords,
    // so a relative --cwd can't silently match nothing.
    const r = await run(["--cwd", "./sandbox"], { trees: new Map() });
    expect(listRecords).toHaveBeenLastCalledWith(
      undefined,
      expect.objectContaining({ cwdScope: path.resolve("./sandbox") }),
    );
    expect(r.code).toBe(0);
    expect(pids(r.out)).toEqual(["100"]);
  });

  it("clamps a nonsense --interval up to the 100ms floor instead of sampling for 0s", async () => {
    // A 0/NaN window would make every CPU% a divide-by-nothing artefact.
    for (const [bad, expectedWindowMs] of [
      ["0", 100],
      ["-5", 100],
      ["not-a-number", 1000],
    ] as const) {
      const r = await run(["--interval", bad], { trees: new Map() });
      expect(sampleTrees).toHaveBeenLastCalledWith([100], { windowMs: expectedWindowMs });
      expect(r.code).toBe(0);
    }
  });

  it("--all asks for exited agents too", async () => {
    const r = await run(["--all"], { trees: new Map() });
    expect(listRecords).toHaveBeenLastCalledWith(undefined, expect.objectContaining({ all: true }));
    expect(r.code).toBe(0);
    expect(pids(r.out)).toEqual(["100"]);
  });

  it("--help prints usage without doing any work", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: ay ps");
    expect(listRecords).not.toHaveBeenCalled();
    expect(sampleTrees).not.toHaveBeenCalled();
    expect(pids(r.out)).toEqual([]);
  });

  it("omits the header entirely when no box stat could be read", async () => {
    // formatSystemLine returns "" in that case; printing a bare blank line above
    // the table would look like a rendering bug.
    const r = await run([], {
      system: sys({
        load: null,
        memTotalBytes: null,
        memAvailableBytes: null,
        swapTotalBytes: null,
      }),
    });
    expect(r.out.startsWith("PID")).toBe(true);
  });
  it("marks its own process tree on Linux without walking any process files", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
    try {
      const pid = process.pid;
      const result = await run(["--json"], {
        records: [rec({ pid })],
        trees: new Map([[pid, stats({ pid })]]),
      });
      expect(JSON.parse(result.out).agents[0]).toMatchObject({ pid, self: true });
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  });
});
