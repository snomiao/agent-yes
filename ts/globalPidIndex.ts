import { appendFile, mkdir, readFile, rename, writeFile } from "fs/promises";
import { homedir } from "os";
import path from "path";
import { lock } from "proper-lockfile";
import { logger } from "./logger.ts";

/**
 * Global, cross-runtime pid registry at `~/.agent-yes/pids.jsonl`.
 *
 * Schema mirrors Rust's `PidRecord` exactly (snake_case) so the Rust binary
 * and the TS implementation can both read and write the same file. Rust
 * uses serde's default (deny-unknown = false), so TS-only extras like
 * `fifo_file` are silently dropped on Rust rewrites — fine, we re-add
 * them on the next TS status update.
 *
 * Wire format (one JSON object per line, JSONL):
 *
 *   {"pid":1234,"cli":"claude","prompt":null,"cwd":"/foo",
 *    "log_file":"/foo/.agent-yes/1234.raw.log",
 *    "fifo_file":"/foo/.agent-yes/fifo/1234.stdin",
 *    "status":"active","exit_code":null,"exit_reason":null,
 *    "started_at":1735689600000}
 *
 * Append semantics (TS) + rewrite-on-update (Rust) coexist because the
 * reader always merges by `pid`, last-line wins.
 */

export interface GlobalPidRecord {
  pid: number;
  cli: string;
  prompt: string | null;
  cwd: string;
  log_file: string | null;
  fifo_file?: string | null;
  status: "active" | "idle" | "exited";
  exit_code: number | null;
  exit_reason: string | null;
  started_at: number;
}

/**
 * Resolved at call time (not module load time) so tests and other callers
 * can override via $AGENT_YES_HOME without juggling module-cache resets.
 * Falls back to `~/.agent-yes` for normal user runs.
 */
function resolveGlobalDir(): string {
  return process.env.AGENT_YES_HOME ?? path.join(homedir(), ".agent-yes");
}

function resolveGlobalFile(): string {
  return path.join(resolveGlobalDir(), "pids.jsonl");
}

export function getGlobalPidIndexPath(): string {
  return resolveGlobalFile();
}

async function ensureDir() {
  await mkdir(resolveGlobalDir(), { recursive: true });
}

async function withLock<R>(fn: () => Promise<R>): Promise<R> {
  await ensureDir();
  const file = resolveGlobalFile();
  const dir = resolveGlobalDir();
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lock(dir, {
      lockfilePath: file + ".lock",
      retries: { retries: 5, minTimeout: 50, maxTimeout: 500 },
    });
    return await fn();
  } finally {
    await release?.();
  }
}

/** Append one full record line. Caller must provide all required fields. */
export async function appendGlobalPid(record: GlobalPidRecord): Promise<void> {
  try {
    await withLock(async () => {
      await appendFile(resolveGlobalFile(), JSON.stringify(record) + "\n");
    });
  } catch (error) {
    logger.debug("[globalPidIndex] append failed:", error);
  }
}

/** Append a partial status update by pid (status, exit_code, exit_reason). */
export async function updateGlobalPidStatus(
  pid: number,
  patch: Partial<Pick<GlobalPidRecord, "status" | "exit_code" | "exit_reason">>,
): Promise<void> {
  try {
    await withLock(async () => {
      const current = await readGlobalPidsRaw();
      const existing = current.find((r) => r.pid === pid);
      if (!existing) return; // unknown pid — nothing to update
      const merged: GlobalPidRecord = { ...existing, ...patch };
      await appendFile(resolveGlobalFile(), JSON.stringify(merged) + "\n");
    });
  } catch (error) {
    logger.debug("[globalPidIndex] updateStatus failed:", error);
  }
}

/**
 * Read the file once without merge logic — internal helper for status updates.
 */
async function readGlobalPidsRaw(): Promise<GlobalPidRecord[]> {
  let raw: string;
  try {
    raw = await readFile(resolveGlobalFile(), "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const merged = new Map<number, GlobalPidRecord>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const doc = JSON.parse(trimmed) as GlobalPidRecord;
      if (typeof doc.pid !== "number") continue;
      const prev = merged.get(doc.pid);
      merged.set(doc.pid, prev ? { ...prev, ...doc } : doc);
    } catch {
      // skip corrupt
    }
  }
  return Array.from(merged.values());
}

/**
 * Read all records, last-line-per-pid wins (events get merged).
 * Optionally filter to live processes only.
 */
export async function readGlobalPids(
  opts: {
    liveOnly?: boolean;
  } = {},
): Promise<GlobalPidRecord[]> {
  const records = await readGlobalPidsRaw();
  if (!opts.liveOnly) return records;
  return records.filter((r) => r.status !== "exited" && isProcessAlive(r.pid));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const COMPACT_THRESHOLD_LINES = 500; // raw events; one merged record per pid

/**
 * Best-effort compaction: rewrite the JSONL file with one line per known pid,
 * dropping records whose pid is dead AND status is exited (those won't be
 * referenced by `cy ls` anyway). Triggered opportunistically when the raw
 * file grows past `COMPACT_THRESHOLD_LINES`. Safe to call unconditionally;
 * it no-ops when the file is already small enough.
 */
export async function maybeCompactGlobalPids(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(resolveGlobalFile(), "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") return;
    return;
  }
  const lineCount = raw.split("\n").filter((l) => l.trim()).length;
  if (lineCount < COMPACT_THRESHOLD_LINES) return;

  try {
    await withLock(async () => {
      const merged = await readGlobalPidsRaw();
      // Drop dead-and-exited entries; keep dead-but-not-yet-exited so a later
      // status-update from elsewhere can still be matched against them.
      const keep = merged.filter((r) => r.status !== "exited" || isProcessAlive(r.pid));
      const tmpFile = resolveGlobalFile() + ".compact";
      const content = keep.map((r) => JSON.stringify(r)).join("\n") + (keep.length ? "\n" : "");
      await writeFile(tmpFile, content);
      await rename(tmpFile, resolveGlobalFile());
      logger.debug(`[globalPidIndex] compacted ${lineCount} → ${keep.length} lines`);
    });
  } catch (error) {
    logger.debug("[globalPidIndex] compact failed:", error);
  }
}
