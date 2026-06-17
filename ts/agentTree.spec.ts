import { expect, test } from "vitest";
import { buildAgentForest, flattenForest } from "./agentTree.ts";
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
