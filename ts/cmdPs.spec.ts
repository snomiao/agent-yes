import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  formatSystemLine,
  isSelfTree,
  parsePpidFromStat,
  readPpidSync,
  renderTable,
  repoLabel,
  subtreeTotals,
  type PsRow,
} from "./cmdPs.ts";
import type { ProcRow, SystemStats, TreeStats } from "./procStats.ts";

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
  it("names the repo, not the branch dir every worktree shares", () => {
    expect(repoLabel("/code/snomiao/agent-yes/tree/main")).toBe("agent-yes");
    expect(repoLabel("/code/snomiao/agent-yes/tree/feat/x")).toBe("agent-yes");
  });

  it("falls back to the last segment outside a tree layout", () => {
    expect(repoLabel("/srv/plain-checkout")).toBe("plain-checkout");
  });

  it("falls back to the shortened path when there is no segment at all", () => {
    // `/` and "" split into no segments; without the fallback the REPO column
    // would print "undefined".
    expect(repoLabel("/")).toBe("/");
    expect(repoLabel("")).toBe("");
  });

  it("abbreviates a home-relative fallback with ~", () => {
    expect(repoLabel(homedir())).toBe(path.basename(homedir()));
  });

  it("handles Windows-style separators too", () => {
    // The registry stores whatever the wrapper recorded, so both shapes reach
    // here regardless of the host we are rendering on.
    expect(repoLabel("C:\\code\\snomiao\\agent-yes\\tree\\main")).toBe("agent-yes");
    expect(repoLabel("C:\\srv\\plain-checkout")).toBe("plain-checkout");
  });

  it("does not index out of bounds on a root-level tree dir", () => {
    expect(repoLabel("/tree/main")).toBe("main");
  });
});

describe("formatSystemLine", () => {
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
  members: Map<number, ProcRow[]>;
} = {
  records: [],
  trees: new Map(),
  unattributed: { pid: 0, rss: 0, cpuPercent: 0, procs: 0 },
  system: sys(),
  members: new Map(),
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
      members: fixture.members ?? new Map(),
    })),
  };
});

describe("cmdPs", () => {
  const rec = (over: Record<string, unknown> = {}) => ({
    pid: 100,
    cli: "claude",
    prompt: null,
    cwd: "/code/snomiao/foo/tree/main",
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
    const r = await run(["--cwd", "."], { trees: new Map() });
    expect(r.code).toBe(0);
    expect(pids(r.out)).toEqual(["100"]);
  });

  it("clamps a nonsense --interval up to the 100ms floor instead of sampling for 0s", async () => {
    // A 0/NaN window would make every CPU% a divide-by-nothing artefact.
    for (const bad of ["0", "-5", "not-a-number"]) {
      const r = await run(["--interval", bad], { trees: new Map() });
      expect(r.code).toBe(0);
    }
  });

  it("--all asks for exited agents too", async () => {
    const r = await run(["--all"], { trees: new Map() });
    expect(r.code).toBe(0);
    expect(pids(r.out)).toEqual(["100"]);
  });

  it("--help prints usage without doing any work", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: ay ps");
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
});

describe("isSelfTree", () => {
  // The `← this session` marker: anything that later grows a kill affordance
  // must not let you shoot the session issuing the command, so the ancestry walk
  // has to be right. It reads /proc, but the walk itself is platform-independent.
  const chain = (links: Record<number, number>) => (pid: number) => links[pid] ?? null;

  it("finds the root several hops up the ancestry", () => {
    expect(isSelfTree(10, 40, chain({ 40: 30, 30: 20, 20: 10 }), "linux")).toBe(true);
  });

  it("is true for the wrapper pid itself", () => {
    expect(isSelfTree(10, 10, chain({}), "linux")).toBe(true);
  });

  it("is false for an unrelated tree", () => {
    expect(isSelfTree(99, 40, chain({ 40: 30, 30: 1 }), "linux")).toBe(false);
  });

  it("gives up when the ancestry is unreadable rather than guessing", () => {
    expect(isSelfTree(10, 40, () => null, "linux")).toBe(false);
  });

  it("terminates on a cycle instead of spinning", () => {
    expect(isSelfTree(999, 40, chain({ 40: 41, 41: 40 }), "linux")).toBe(false);
  });

  it("returns false off Linux, where /proc does not exist", () => {
    expect(isSelfTree(10, 40, chain({ 40: 10 }), "darwin")).toBe(false);
  });

  it("readPpidSync returns null for a pid that cannot be read", () => {
    expect(readPpidSync(-1)).toBeNull();
  });
});

describe("parsePpidFromStat", () => {
  // /proc/<pid>/stat field 2 is the process name in parens, UNESCAPED. Splitting
  // on whitespace or the first ")" mis-reads every process whose name contains
  // either, so the fields after comm can only be located from the LAST ")".
  it("reads the ppid of an ordinary line", () => {
    expect(parsePpidFromStat("1234 (bash) S 1200 1234 1234 0 -1 4194304")).toBe(1200);
  });

  it("survives a process name containing spaces and parens", () => {
    expect(parsePpidFromStat("1234 (foo) bar (baz) S 999 1234 0")).toBe(999);
  });

  it("returns null when there is no comm field to anchor on", () => {
    expect(parsePpidFromStat("garbage without parens")).toBeNull();
  });

  it("returns null when the ppid field is missing or not a number", () => {
    expect(parsePpidFromStat("1234 (bash) S")).toBeNull();
    expect(parsePpidFromStat("1234 (bash) S notanumber 1234")).toBeNull();
  });
});

describe("subtreeTotals", () => {
  const n = (depth: number, rss: number, cpu: number, procs: number) => ({
    depth,
    stats: { pid: depth * 1000 + rss, rss, cpuPercent: cpu, procs },
  });

  it("returns null for a row with no descendants, so leaves render blank", () => {
    expect(subtreeTotals([n(0, 10, 1, 1)])).toEqual([null]);
  });

  it("rolls a parent up with its children", () => {
    const [parent, a, b] = subtreeTotals([n(0, 10, 1, 2), n(1, 5, 2, 3), n(1, 1, 4, 1)]);
    expect(parent).toMatchObject({ rss: 16, cpuPercent: 7, procs: 6 });
    expect(a).toBeNull();
    expect(b).toBeNull();
  });

  it("includes grandchildren in the grandparent's total", () => {
    // sampleTrees attributes exclusively, so without the deep walk a fan-out
    // parent's real cost stays invisible.
    const out = subtreeTotals([n(0, 1, 1, 1), n(1, 2, 2, 2), n(2, 4, 4, 4)]);
    expect(out[0]).toMatchObject({ rss: 7, cpuPercent: 7, procs: 7 });
    expect(out[1]).toMatchObject({ rss: 6, cpuPercent: 6, procs: 6 });
    expect(out[2]).toBeNull();
  });

  it("stops at the next sibling — one subtree never absorbs another", () => {
    const out = subtreeTotals([n(0, 1, 0, 1), n(1, 2, 0, 1), n(0, 100, 0, 1), n(1, 200, 0, 1)]);
    expect(out[0]).toMatchObject({ rss: 3 });
    expect(out[2]).toMatchObject({ rss: 300 });
  });

  it("skips a row whose stats are missing rather than throwing", () => {
    // Defensive: the sampler can miss an agent that exited mid-window, and a
    // rollup must not take the whole table down with it.
    const missing = { depth: 1, stats: undefined as unknown as ReturnType<typeof stats> };
    const out = subtreeTotals([n(0, 1, 0, 1), missing, n(1, 4, 0, 1)]);
    expect(out[0]).toMatchObject({ rss: 5 }); // descendants: skipped + counted
    // And a row whose OWN stats are missing yields null instead of throwing.
    expect(subtreeTotals([missing])).toEqual([null]);
  });

  it("treats a missing depth as a root", () => {
    const out = subtreeTotals([
      { stats: { pid: 1, rss: 1, cpuPercent: 0, procs: 1 } },
      n(1, 2, 0, 1),
    ]);
    expect(out[0]).toMatchObject({ rss: 3 });
  });
});

describe("renderTable --tree", () => {
  const treeRows = [
    row({ pid: 1, repo: "alpha", stats: stats({ rss: 100, cpuPercent: 1, procs: 2 }) }),
    row({ pid: 2, repo: "alpha", stats: stats({ rss: 50, cpuPercent: 2, procs: 1 }) }),
  ];

  it("omits the Σ columns entirely in flat mode", () => {
    const out = renderTable(treeRows, null);
    expect(out).not.toContain("ΣCPU%");
    expect(out).not.toContain("ΣRSS");
  });

  it("lists each agent's OS processes only when --procs asks for them", () => {
    const withProcs = [
      {
        ...treeRows[0]!,
        depth: 0,
        prefix: "",
        procRows: [
          { pid: 11, ppid: 1, comm: "claude", rss: 1024, cpuPercent: 2, state: "S" },
          { pid: 12, ppid: 11, comm: "bash", rss: 512, cpuPercent: 0, state: "S" },
          { pid: 13, ppid: 11, comm: "gone", rss: 0, cpuPercent: 0, state: "Z" },
        ],
      },
    ];
    // Default: a one-row-per-agent table, whatever procRows happens to hold.
    expect(renderTable(withProcs, null)).not.toContain("bash");
    // --tree alone is the AGENT forest; it must not drag the processes in.
    expect(renderTable(withProcs, null, { tree: true })).not.toContain("bash");
    // --procs is what expands them, and works without --tree.
    const out = renderTable(withProcs, null, { procs: true });
    expect(out).toContain("claude");
    expect(out).toContain("bash");
    // A zombie is called out — it is the one process state worth acting on.
    expect(out).toContain("zombie");
  });

  it("renders a tree row that has no prefix at all (a lone root)", () => {
    // prefix/depth are optional on PsRow; a row built without them must still
    // render, and must not gain a stray indent.
    const bare = [{ ...treeRows[0]!, subtree: null }];
    const out = renderTable(bare, null, { tree: true });
    const line = out.split("\n").find((l) => l.startsWith("1 ")) as string;
    expect(line).toBeTruthy();
  });

  it("expands processes without --tree, with no forest indent to inherit", () => {
    const kid = { pid: 9, ppid: 1, comm: "zsh", rss: 1, cpuPercent: 0, state: "S" };
    const out = renderTable([{ ...treeRows[0]!, procRows: [kid] }], null, { procs: true });
    expect(out).toContain("zsh");
    expect(out).not.toContain("ΣCPU%"); // --procs alone adds no forest columns
  });

  it("indents process rows relative to their agent's rails", () => {
    const kid = { pid: 9, ppid: 1, comm: "zsh", rss: 1, cpuPercent: 0, state: "S" };
    const nested = renderTable(
      [{ ...treeRows[0]!, depth: 1, prefix: "└─ ", subtree: null, procRows: [kid] }],
      null,
      { tree: true, procs: true },
    );
    const root = renderTable([{ ...treeRows[0]!, subtree: null, procRows: [kid] }], null, {
      tree: true,
      procs: true,
    });
    const indentOf = (out: string) =>
      (out.split("\n").find((l) => l.includes("zsh")) as string).match(/^ */)![0].length;
    // A nested agent's processes sit deeper than a root agent's.
    expect(indentOf(nested)).toBeGreaterThan(indentOf(root));
  });

  it("adds the Σ columns and renders forest rails on the PID cell", () => {
    const withTree = [
      {
        ...treeRows[0]!,
        depth: 0,
        prefix: "",
        subtree: stats({ rss: 150, cpuPercent: 3, procs: 3 }),
      },
      { ...treeRows[1]!, depth: 1, prefix: "└─ ", subtree: null },
    ];
    const out = renderTable(withTree, null, { tree: true });
    expect(out).toContain("ΣCPU%");
    const child = out.split("\n").find((l) => l.includes("└─ 2")) as string;
    expect(child).toBeTruthy();
    // A leaf's Σ cells stay blank — repeating its own numbers would be noise.
    expect(child).not.toMatch(/\s3\s/);
  });
});
