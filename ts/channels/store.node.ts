// Node/Bun jsonl backend for a channel replica.
//
// One append-only file per channel, colocated with the project like the rest of
// agent-yes's per-cwd state (`<cwd>/.agent-yes/ch-<channelId>.jsonl` — the same
// convention as messageLog.ts's inbox/outbox). Writes follow messageLog's
// lock-free discipline: an O_APPEND of one line is atomic on POSIX, and reads
// dedup by op id, so a concurrent CLI + daemon appending the same op at worst
// writes a duplicate line that the next read/compaction collapses — never a lost
// or torn record. Best-effort, and never blocks a send.

import { appendFile, mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { isValidOp, type Op } from "./op.ts";
import { mergeOps, sortOps } from "./store.ts";

/** Rewrite (dedup + sort) once the file grows past this many raw lines. */
const COMPACT_AT_LINES = 4000;

/** Path to a channel's jsonl replica under a project cwd. */
export function channelFilePath(cwd: string, channelId: string): string {
  return path.join(cwd, ".agent-yes", `ch-${channelId}.jsonl`);
}

/** Read + parse a channel's ops, deduped and HLC-sorted. Missing file → []. */
export async function readOps(cwd: string, channelId: string): Promise<Op[]> {
  let raw: string;
  try {
    raw = await readFile(channelFilePath(cwd, channelId), "utf-8");
  } catch {
    return [];
  }
  const byId = new Map<string, Op>();
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const op = JSON.parse(t);
      if (isValidOp(op) && !byId.has(op.id)) byId.set(op.id, op);
    } catch {
      /* skip corrupt/partial line */
    }
  }
  return sortOps([...byId.values()]);
}

/**
 * Append `incoming` to a channel, deduping against what's already stored.
 * Returns the ops that were genuinely new (so the daemon can rebroadcast just
 * those). Opportunistically compacts when the file accumulates duplicate lines
 * or grows large, keeping it bounded despite append-only writes.
 */
export async function appendOps(cwd: string, channelId: string, incoming: Op[]): Promise<Op[]> {
  const valid = incoming.filter(isValidOp);
  if (valid.length === 0) return [];
  const file = channelFilePath(cwd, channelId);
  await mkdir(path.dirname(file), { recursive: true });

  const existing = await readOps(cwd, channelId);
  const { added } = mergeOps(existing, valid);
  if (added.length === 0) return [];

  await appendFile(file, added.map((op) => JSON.stringify(op)).join("\n") + "\n");

  // Compact if the on-disk line count now exceeds the deduped op count enough to
  // matter (duplicates from concurrent writers) or crosses the size cap.
  const rawLines = existing.length + valid.length; // upper bound on lines just written+read
  if (rawLines > COMPACT_AT_LINES) {
    const all = sortOps([...existing, ...added]);
    await writeFile(file, all.map((op) => JSON.stringify(op)).join("\n") + "\n");
  }
  return added;
}
