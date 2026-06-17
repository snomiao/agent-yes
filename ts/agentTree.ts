/**
 * Agent hierarchy: link the flat pid registry into a parent→child forest and
 * render it as a tree.
 *
 * A nested `ay` launched from inside another agent inherits its parent's
 * wrapper pid via the AGENT_YES_PID env var (injected by both runtimes — see
 * ts/index.ts and rs/src/pty_spawner.rs). We record that as `parent_pid`, so a
 * child links to its parent with:  child.parent_pid === parent.wrapper_pid.
 *
 * Used by `ay ls` (CLI table) and the console (the deepest "agents > agents
 * subtree" layer of signalling-server > rooms > peers > agents > subtree).
 */

import type { GlobalPidRecord } from "./globalPidIndex.ts";

export interface ForestNode {
  record: GlobalPidRecord;
  children: ForestNode[];
}

/**
 * Link records into a forest via parent_pid === wrapper_pid. Records whose
 * parent isn't present in the set (top-level agents, or links into agents
 * filtered out by a keyword/scope) become roots. Root and sibling order follows
 * the input order, so a caller that pre-sorts (e.g. newest-first) is preserved.
 */
export function buildAgentForest(records: GlobalPidRecord[]): ForestNode[] {
  const nodes: ForestNode[] = records.map((record) => ({ record, children: [] }));
  const byWrapper = new Map<number, ForestNode>();
  for (const n of nodes) {
    const w = n.record.wrapper_pid;
    // If two live agents ever share a wrapper pid (pid reuse across a reboot),
    // last one wins — harmless for display.
    if (typeof w === "number" && w > 0) byWrapper.set(w, n);
  }
  const roots: ForestNode[] = [];
  for (const n of nodes) {
    const p = n.record.parent_pid;
    const parent = typeof p === "number" && p > 0 ? byWrapper.get(p) : undefined;
    if (parent && parent !== n) parent.children.push(n);
    else roots.push(n);
  }
  // Cycle safety: a 2+ node parent_pid cycle (possible only via pid reuse across a
  // reboot) links every member as someone's child, so none become roots and they'd
  // vanish from the output entirely. Mark everything reachable from the current
  // roots, then append any unreached node as its own root; flattenForest's visited
  // guard then renders each exactly once. Mirrors the console JS recovery pass
  // (lab/ui/console-logic.js agentForestNodes).
  const seen = new Set<ForestNode>();
  const mark = (n: ForestNode) => {
    if (seen.has(n)) return;
    seen.add(n);
    n.children.forEach(mark);
  };
  roots.forEach(mark);
  for (const n of nodes) if (!seen.has(n)) roots.push(n);
  return roots;
}

export interface FlatRow {
  record: GlobalPidRecord;
  /** Box-drawing branch prefix, e.g. "", "├─ ", "│  └─ ". Empty for roots. */
  prefix: string;
  depth: number;
}

/**
 * Depth-first flatten a forest into rows carrying a box-drawing branch prefix.
 * A `visited` guard makes a pathological parent_pid cycle terminate instead of
 * recursing forever.
 */
export function flattenForest(roots: ForestNode[]): FlatRow[] {
  const rows: FlatRow[] = [];
  const visited = new Set<ForestNode>();
  const walk = (node: ForestNode, ancestorsLast: boolean[]) => {
    if (visited.has(node)) return;
    visited.add(node);
    const depth = ancestorsLast.length;
    let prefix = "";
    for (let i = 0; i < depth - 1; i++) prefix += ancestorsLast[i] ? "   " : "│  ";
    if (depth > 0) prefix += ancestorsLast[depth - 1] ? "└─ " : "├─ ";
    rows.push({ record: node.record, prefix, depth });
    node.children.forEach((c, i) => walk(c, [...ancestorsLast, i === node.children.length - 1]));
  };
  for (const r of roots) walk(r, []);
  return rows;
}

/**
 * Generic VSCode-explorer-style layered tree node, used by the console to nest
 * rooms > peers > agents and fold away any layer that has a single child.
 */
export interface LayerNode {
  /** Short label for this layer node, e.g. a room name, host, or agent title. */
  label: string;
  /** Layer kind, for styling/icons in the UI (e.g. "room", "peer", "agent"). */
  kind: string;
  children: LayerNode[];
  /** Arbitrary payload (e.g. the agent record) for leaves. */
  data?: unknown;
}

export interface FoldedRow {
  /** Labels folded onto this one line (a single-child chain), parent→child. */
  segments: { label: string; kind: string }[];
  depth: number;
  prefix: string;
  node: LayerNode;
}

/**
 * Fold + flatten a layer forest the way VSCode's explorer collapses a chain of
 * single-child folders (`com/example/app`) onto one row, and only indents into a
 * tree where a node actually has multiple children.
 *
 * - A node with exactly one child is merged with that child: their labels join
 *   on this row and we descend without adding depth.
 * - A node with 0 or ≥2 children ends the current row; each child (when ≥2)
 *   starts a new indented row with ├─ / └─ branches.
 */
export function foldLayers(roots: LayerNode[]): FoldedRow[] {
  const rows: FoldedRow[] = [];
  const visited = new Set<LayerNode>();
  const walk = (start: LayerNode, ancestorsLast: boolean[]) => {
    // Collapse the single-child chain starting at `start`.
    const segments: { label: string; kind: string }[] = [];
    let node = start;
    while (true) {
      if (visited.has(node)) break;
      visited.add(node);
      segments.push({ label: node.label, kind: node.kind });
      if (node.children.length === 1) {
        node = node.children[0]!;
        continue;
      }
      break;
    }
    const depth = ancestorsLast.length;
    let prefix = "";
    for (let i = 0; i < depth - 1; i++) prefix += ancestorsLast[i] ? "   " : "│  ";
    if (depth > 0) prefix += ancestorsLast[depth - 1] ? "└─ " : "├─ ";
    rows.push({ segments, depth, prefix, node });
    // Branch into the children of the chain's tail (only reached when ≥2).
    node.children.forEach((c, i) => walk(c, [...ancestorsLast, i === node.children.length - 1]));
  };
  // A single root collapses away too: only branch the roots when there are ≥2.
  for (const r of roots) walk(r, []);
  return rows;
}
