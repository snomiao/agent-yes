import { expect, test } from "vitest";
import { buildAgentForest, flattenForest, foldLayers } from "./agentTree.ts";
import type { LayerNode } from "./agentTree.ts";
import type { GlobalPidRecord } from "./globalPidIndex.ts";

const mk = (pid: number, wrapper_pid: number, parent_pid?: number): GlobalPidRecord =>
  ({ pid, wrapper_pid, parent_pid }) as GlobalPidRecord;

const pidsOf = (recs: GlobalPidRecord[]) =>
  flattenForest(buildAgentForest(recs))
    .map((r) => r.record.pid)
    .sort((a, b) => a - b);

test("links child under parent via parent_pid === wrapper_pid", () => {
  const rows = flattenForest(buildAgentForest([mk(1, 10), mk(2, 20, 10)]));
  expect(rows.map((r) => r.record.pid)).toEqual([1, 2]);
  expect(rows[1]!.depth).toBe(1); // child indented under root
});

test("orphan (parent not present) renders at top level, never vanishes", () => {
  const rows = flattenForest(buildAgentForest([mk(1, 10), mk(2, 20, 10), mk(3, 30, 999)]));
  expect(pidsOf([mk(1, 10), mk(2, 20, 10), mk(3, 30, 999)])).toEqual([1, 2, 3]);
  expect(rows.find((r) => r.record.pid === 3)!.depth).toBe(0); // orphan is a root
});

// Regression: a parent_pid cycle (only via pid reuse across a reboot) used to
// drop every node in the cycle, since none became a root — they'd disappear from
// `ay ls` entirely. Each node must still render exactly once.
test("2-node parent_pid cycle still renders both nodes", () => {
  expect(pidsOf([mk(1, 10, 20), mk(2, 20, 10)])).toEqual([1, 2]);
});

test("3-node parent_pid cycle still renders all nodes", () => {
  expect(pidsOf([mk(1, 10, 30), mk(2, 20, 10), mk(3, 30, 20)])).toEqual([1, 2, 3]);
});

test("self-parent is treated as a root, not dropped or self-nested", () => {
  expect(pidsOf([mk(1, 10, 10)])).toEqual([1]);
});

// foldLayers: the VSCode-explorer-style collapse used by the console to nest
// rooms > peers > agents and fold single-child chains onto one row.
const ln = (label: string, children: LayerNode[] = []): LayerNode => ({
  label,
  kind: "node",
  children,
});

test("foldLayers collapses a single-child chain onto one row", () => {
  const rows = foldLayers([ln("a", [ln("b", [ln("c")])])]);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.segments.map((s) => s.label)).toEqual(["a", "b", "c"]);
  expect(rows[0]!.depth).toBe(0);
  expect(rows[0]!.prefix).toBe("");
});

test("foldLayers branches a multi-child node into indented ├─/└─ rows", () => {
  const rows = foldLayers([ln("root", [ln("x"), ln("y")])]);
  expect(rows.map((r) => r.segments[0]!.label)).toEqual(["root", "x", "y"]);
  expect(rows[0]!.depth).toBe(0);
  expect(rows[1]!).toMatchObject({ depth: 1, prefix: "├─ " });
  expect(rows[2]!).toMatchObject({ depth: 1, prefix: "└─ " }); // last child
});

test("foldLayers builds nested prefixes with both ancestor connectors", () => {
  // root → {a (not last), b (last)}, each with two children, so depth-2 rows
  // exercise both ancestor connectors: "│  " under a, "   " under the last child b.
  const rows = foldLayers([
    ln("root", [ln("a", [ln("a1"), ln("a2")]), ln("b", [ln("b1"), ln("b2")])]),
  ]);
  const at = (label: string) => rows.find((r) => r.segments[0]!.label === label)!;
  expect(at("a1")).toMatchObject({ depth: 2, prefix: "│  ├─ " });
  expect(at("a2").prefix).toBe("│  └─ ");
  expect(at("b1").prefix).toBe("   ├─ ");
  expect(at("b2").prefix).toBe("   └─ ");
});

test("foldLayers renders a node shared by two parents only once (visited guard)", () => {
  // Diamond: root → {a, b}, both pointing at the same leaf c. The visited guard
  // folds c into whichever branch reaches it first (a), so it isn't duplicated.
  const c = ln("c");
  const rows = foldLayers([ln("root", [ln("a", [c]), ln("b", [c])])]);
  const labelsOf = (i: number) => rows[i]!.segments.map((s) => s.label);
  expect(labelsOf(0)).toEqual(["root"]);
  expect(labelsOf(1)).toEqual(["a", "c"]); // c folded into a's chain
  expect(rows[1]!.prefix).toBe("├─ ");
  expect(labelsOf(2)).toEqual(["b"]); // b's duplicate c is skipped, not re-rendered
  expect(rows[2]!.prefix).toBe("└─ ");
  expect(rows.flatMap((r) => r.segments.map((s) => s.label)).filter((l) => l === "c")).toHaveLength(
    1,
  );
});
