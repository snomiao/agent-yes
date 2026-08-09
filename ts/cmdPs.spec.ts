import { describe, expect, it } from "vitest";
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
