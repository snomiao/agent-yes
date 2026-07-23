/**
 * Read-side views over the `ay todo` store: dependency-tree rendering and a
 * per-tag digest board. Pure functions over an already-loaded task list — no
 * I/O — so they are trivially unit-testable and reusable by both the CLI
 * (`todoCli.ts`) and any future web view.
 *
 * `unblockedTasks` is ported near-verbatim from the equivalent, already
 * mutation-tested algorithm in symval-dev-cli's `deps.ts` (a closed-source
 * downstream consumer of an earlier, less general version of this idea) —
 * generalized here to the new `TodoRecord` shape and the `done` state name
 * from `todoLifecycle.ts` instead of a hardcoded status string.
 */

import { DONE_STATE } from "./todoLifecycle.ts";
import type { TodoRecord } from "./todoStore.ts";

/**
 * A task is "unblocked" when it is not itself finished, it declares
 * `blockedBy` dependencies, and every one of them has reached `done`.
 * Surfaced for a caller to act on — never auto-applied here (deciding to
 * resume a task is left to automation, a later milestone, or a human).
 */
export function unblockedTasks(tasks: TodoRecord[]): TodoRecord[] {
  const byId = new Map(tasks.map((t) => [t._id, t]));
  return tasks.filter((t) => {
    if (t.state === DONE_STATE) return false;
    if (t.blockedBy.length === 0) return false;
    return t.blockedBy.every((d) => byId.get(d)?.state === DONE_STATE);
  });
}

/** Blockers of `t` that have not reached `done` yet (a missing id is reported as-is, still "open"). */
export function openBlockers(t: TodoRecord, byId: Map<string, TodoRecord>): string[] {
  return t.blockedBy.filter((d) => byId.get(d)?.state !== DONE_STATE);
}

function nodeLine(t: TodoRecord): string {
  const bits = [`${t._id} [${t.state}] ${t.summary}`, ...(t.owner ? [`owner:${t.owner}`] : [])];
  return bits.join("  ");
}

/**
 * Dependency tree, rendered from roots (tasks nothing depends on, that
 * themselves declare at least one dependency) down their `blockedBy` edges:
 * a parent's children are what it is waiting for.
 */
export function renderTree(tasks: TodoRecord[], rootId?: string): string {
  const byId = new Map(tasks.map((t) => [t._id, t]));
  const dependedOn = new Set(tasks.flatMap((t) => t.blockedBy));
  const roots = rootId
    ? [byId.get(rootId) ?? null].filter((t): t is TodoRecord => t !== null)
    : tasks.filter((t) => !dependedOn.has(t._id) && t.blockedBy.length > 0);
  if (rootId && roots.length === 0) throw new Error(`no such task: ${rootId}`);
  if (roots.length === 0) return "(no dependency links)";

  const lines: string[] = [];
  const walk = (
    t: TodoRecord,
    prefix: string,
    isLast: boolean,
    depth: number,
    seen: Set<string>,
  ): void => {
    lines.push(depth === 0 ? nodeLine(t) : `${prefix}${isLast ? "└─" : "├─"} ${nodeLine(t)}`);
    if (seen.has(t._id)) return;
    seen.add(t._id);
    const deps = t.blockedBy
      .map((d) => byId.get(d))
      .filter((x): x is TodoRecord => x !== undefined);
    deps.forEach((d, i) => {
      const childPrefix = depth === 0 ? "" : `${prefix}${isLast ? "   " : "│  "}`;
      walk(d, childPrefix, i === deps.length - 1, depth + 1, seen);
    });
  };
  roots.forEach((r) => walk(r, "", true, 0, new Set()));
  return lines.join("\n");
}

export interface TreeNode {
  id: string;
  state: string;
  summary: string;
  owner?: string;
  children: TreeNode[];
}

/**
 * JSON-shaped equivalent of `renderTree` — same roots-and-edges logic, built
 * as data instead of formatted lines, so a machine caller (`--format json`)
 * gets the actual tree structure rather than a string it would have to
 * re-parse (codex-review Important: the CLI previously ignored --format for
 * this command entirely, always writing the human text with exit code 0).
 */
export function buildTreeJSON(tasks: TodoRecord[], rootId?: string): TreeNode[] {
  const byId = new Map(tasks.map((t) => [t._id, t]));
  const dependedOn = new Set(tasks.flatMap((t) => t.blockedBy));
  const roots = rootId
    ? [byId.get(rootId) ?? null].filter((t): t is TodoRecord => t !== null)
    : tasks.filter((t) => !dependedOn.has(t._id) && t.blockedBy.length > 0);
  if (rootId && roots.length === 0) throw new Error(`no such task: ${rootId}`);

  const build = (t: TodoRecord, seen: Set<string>): TreeNode => {
    const node: TreeNode = {
      id: t._id,
      state: t.state,
      summary: t.summary,
      ...(t.owner ? { owner: t.owner } : {}),
      children: [],
    };
    if (seen.has(t._id)) return node; // cycles cannot exist (store rejects them), but stay robust
    seen.add(t._id);
    node.children = t.blockedBy
      .map((d) => byId.get(d))
      .filter((x): x is TodoRecord => x !== undefined)
      .map((d) => build(d, seen));
    return node;
  };
  return roots.map((r) => build(r, new Set()));
}

/** Per-tag board: state counts per tag, plus an unblocked-tasks callout. */
export function renderDigest(tasks: TodoRecord[]): string {
  if (tasks.length === 0) return "(no tasks)";
  const byId = new Map(tasks.map((t) => [t._id, t]));
  const unblocked = new Set(unblockedTasks(tasks).map((t) => t._id));

  const streams = new Map<string, TodoRecord[]>();
  for (const t of tasks) {
    for (const tag of t.tags.length ? t.tags : ["(untagged)"]) {
      if (!streams.has(tag)) streams.set(tag, []);
      streams.get(tag)!.push(t);
    }
  }

  const lines: string[] = [];
  for (const [stream, items] of [...streams.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const allStates = [...new Set(items.map((t) => t.state))].sort();
    const counts = allStates
      .map((s) => `${s}:${items.filter((t) => t.state === s).length}`)
      .join(" ");
    lines.push(`## ${stream}  (${counts})`);
    for (const s of allStates) {
      for (const t of items.filter((x) => x.state === s)) {
        const open = openBlockers(t, byId);
        const extra = [
          ...(t.owner ? [`owner:${t.owner}`] : []),
          ...(t.block ? [`block:${t.block.type}`] : []),
          ...(open.length ? [`blockedBy:${open.join(",")}`] : []),
          ...(unblocked.has(t._id) ? ["UNBLOCKED"] : []),
        ];
        lines.push(
          `  [${t.state}] ${t._id} ${t.summary}${extra.length ? `  [${extra.join(" ")}]` : ""}`,
        );
      }
    }
    lines.push("");
  }

  const ub = unblockedTasks(tasks);
  if (ub.length) {
    lines.push("## unblocked (all blockers reached done — resume these)");
    for (const t of ub)
      lines.push(`  ${t._id} ${t.summary}${t.owner ? `  (owner:${t.owner})` : ""}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
