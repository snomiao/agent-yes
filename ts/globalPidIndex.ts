import type { Dirent } from "fs";
import { appendFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import type { AgentPermissions } from "./agentPermissions.ts";
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
  // Set by the Rust supervisor when the agent produced no PTY output after a
  // high-signal poke / while a "working" spinner is frozen — i.e. it looks
  // wedged. Orthogonal to `status` (which stays "active"); cleared on recovery
  // and on exit. The ls/status live-state derivation surfaces it as `stuck`.
  unresponsive?: boolean;
  exit_code: number | null;
  exit_reason: string | null;
  started_at: number;
  // The `ay` wrapper process pid that spawned this agent. The wrapper injects
  // its own pid as AGENT_YES_PID into the agent's env (the agent's OWN pid isn't
  // known until after spawn), so this maps that env value back to the agent's
  // canonical record — see resolveSender() in subcommands.ts.
  wrapper_pid?: number | null;
  // The AGENT_YES_PID this wrapper *inherited* from its own environment when it
  // started — i.e. the wrapper_pid of the PARENT agent that spawned this one (a
  // nested `ay` launched from inside another agent). Null for top-level agents
  // started from a human shell. Builds the agent>subagent tree: a child links to
  // its parent via child.parent_pid === parent.wrapper_pid. See buildAgentForest.
  parent_pid?: number | null;
  // Stable id minted once at registration so a share grant or `ay <cmd> <id>`
  // can reference this agent without its ephemeral pid. Mirrors Rust's `agent_id`
  // (snake_case). Currently per-process; cross-restart re-binding is a follow-up
  // (see docs/agent-sharing.md). Preserved verbatim through merges/compaction.
  agent_id?: string | null;
  // The permission posture this agent was SPAWNED with — whether the wrapped CLI
  // got its "yolo" flag, plus the wrapper's own robust/auto-continue flags. The
  // index carries no argv and the wrapper flags never reach the CLI's args at
  // all, so without stamping this at registration "was this agent running with
  // permission checks off?" is unanswerable after the fact. See
  // ts/agentPermissions.ts (mirrored in rs/src/agent_permissions.rs).
  permissions?: AgentPermissions | null;
  // The child CLI's most recent terminal title (OSC 0/2 from its PTY stream —
  // claude/opencode continuously set it to a task summary). The wrapper's
  // title scanner keeps this fresh so `ay whoami` / `ay ls --json` can answer
  // "what is this agent doing" without reading its screen. Mirrors Rust's
  // `title`.
  title?: string | null;
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

// Locks/operates on the `file` the CALLER resolved (at call time). Resolving the
// path up front — before any await — keeps fire-and-forget writes from landing in
// a different ~/.agent-yes if AGENT_YES_HOME changes before the async write runs
// (notably tests that set+reset it around an un-awaited mirror write).
async function withLock<R>(file: string, fn: () => Promise<R>): Promise<R> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
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
  const file = resolveGlobalFile(); // capture at call time (see withLock)
  try {
    await withLock(file, async () => {
      await appendFile(file, JSON.stringify(record) + "\n");
    });
  } catch (error) {
    logger.debug("[globalPidIndex] append failed:", error);
  }
}

/** Append a partial update by pid (status, exit_code, exit_reason, log_file). */
export async function updateGlobalPidStatus(
  pid: number,
  patch: Partial<
    Pick<GlobalPidRecord, "status" | "exit_code" | "exit_reason" | "log_file" | "title">
  >,
): Promise<void> {
  const file = resolveGlobalFile(); // capture at call time (see withLock)
  try {
    await withLock(file, async () => {
      const current = await readGlobalPidsRaw(file);
      const existing = current.find((r) => r.pid === pid);
      if (!existing) return; // unknown pid — nothing to update
      const merged: GlobalPidRecord = { ...existing, ...patch };
      await appendFile(file, JSON.stringify(merged) + "\n");
    });
  } catch (error) {
    logger.debug("[globalPidIndex] updateStatus failed:", error);
  }
}

/**
 * Read the file once without merge logic — internal helper for status updates.
 */
async function readGlobalPidsRaw(file: string = resolveGlobalFile()): Promise<GlobalPidRecord[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
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
  const file = resolveGlobalFile(); // capture at call time (see withLock)
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") return;
    return;
  }
  const lineCount = raw.split("\n").filter((l) => l.trim()).length;
  if (lineCount < COMPACT_THRESHOLD_LINES) return;

  try {
    await withLock(file, async () => {
      const merged = await readGlobalPidsRaw(file);
      // Drop dead-and-exited entries; keep dead-but-not-yet-exited so a later
      // status-update from elsewhere can still be matched against them.
      const keep = merged.filter((r) => r.status !== "exited" || isProcessAlive(r.pid));
      const tmpFile = file + ".compact";
      const content = keep.map((r) => JSON.stringify(r)).join("\n") + (keep.length ? "\n" : "");
      await writeFile(tmpFile, content);
      await rename(tmpFile, file);
      logger.debug(`[globalPidIndex] compacted ${lineCount} → ${keep.length} lines`);
    });
  } catch (error) {
    logger.debug("[globalPidIndex] compact failed:", error);
  }
}

/** Default log retention: sessions older than this whose process is gone. */
const DEFAULT_RETENTION_DAYS = 7;

function retentionMs(): number {
  const days = Number(process.env.AGENT_YES_LOG_RETENTION_DAYS);
  return (Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
}

/** All on-disk log files associated with a record (raw + rendered + sidecars). */
function logSiblings(logFile: string | null): string[] {
  if (!logFile) return [];
  // logFile may point at either `<pid>.raw.log` or `<pid>.log`; derive the rest.
  const base = logFile.replace(/\.raw\.log$|\.log$/, "");
  return [`${base}.raw.log`, `${base}.log`, `${base}.lines.log`, `${base}.debug.log`];
}

export interface LogGcResult {
  /** Absolute paths of the log files that were removed. */
  removed: string[];
  /** Total bytes reclaimed (0 for files whose size could not be read). */
  freedBytes: number;
}

/**
 * Delete one log file, reporting the bytes it held. Returns null when nothing
 * was removed (already gone, or not ours to delete) so callers can count only
 * real deletions.
 */
async function removeLogFile(file: string): Promise<number | null> {
  let size = 0;
  try {
    size = (await stat(file)).size;
  } catch {
    // Unreadable/missing — unlink below still decides whether it counted.
  }
  try {
    await unlink(file);
    return size;
  } catch {
    return null; // missing / already gone — ignore
  }
}

/**
 * Index-driven retention sweep: delete the log files of sessions whose process
 * is gone (exited or dead pid) and that started longer ago than the retention
 * window. Because the index records absolute `log_file` paths, this reclaims
 * logs scattered across many project `.agent-yes/` dirs from one call.
 * Best-effort; never throws. Returns the number of files removed.
 */
export async function pruneOldLogs(maxAgeMs: number = retentionMs()): Promise<number> {
  const { removed } = await pruneOldLogsDetailed(maxAgeMs);
  return removed.length;
}

async function pruneOldLogsDetailed(maxAgeMs: number = retentionMs()): Promise<LogGcResult> {
  const result: LogGcResult = { removed: [], freedBytes: 0 };
  let records: GlobalPidRecord[];
  try {
    records = await readGlobalPidsRaw();
  } catch {
    return result;
  }
  const now = Date.now();
  for (const r of records) {
    const dead = r.status === "exited" || !isProcessAlive(r.pid);
    const old = now - (r.started_at ?? now) > maxAgeMs;
    if (!dead || !old) continue;
    for (const f of logSiblings(r.log_file)) {
      const freed = await removeLogFile(f);
      if (freed === null) continue;
      result.removed.push(f);
      result.freedBytes += freed;
    }
  }
  if (result.removed.length > 0) {
    logger.debug(`[globalPidIndex] pruned ${result.removed.length} stale log file(s)`);
    await maybeCompactGlobalPids();
  }
  return result;
}

/** `<pid>.log`, `<pid>.raw.log`, `<pid>.lines.log`, `<pid>.debug.log` — nothing else. */
const PID_LOG_FILE = /^(\d+)\.(?:raw\.log|lines\.log|debug\.log|log)$/;

/**
 * Every `.agent-yes/` dir that might hold logs: this process's cwd plus the
 * dir of each path the index knows about. Records are the only breadcrumb to
 * *other* projects, so a pid whose record is gone is still reachable as long
 * as some sibling record points at the same dir.
 */
function candidateLogDirs(records: GlobalPidRecord[]): string[] {
  const dirs = new Set<string>([path.resolve(process.cwd(), ".agent-yes")]);
  for (const r of records) {
    if (r.log_file) dirs.add(path.resolve(path.dirname(r.log_file)));
    if (r.cwd) dirs.add(path.resolve(r.cwd, ".agent-yes"));
  }
  return [...dirs];
}

/**
 * Directory-driven sweep for **orphaned** logs — the ones `pruneOldLogs` can
 * never see.
 *
 * `maybeCompactGlobalPids` drops records that are dead AND exited, but
 * `pruneOldLogs` only deletes a log once its record is older than the
 * retention window. A session that exits cleanly is therefore compacted out of
 * the index long before its log ages out, and with the record goes the only
 * record of the `log_file` path — the file is then unreclaimable by any
 * index-driven pass. Left alone, those accumulate for as long as a machine
 * keeps running agents, and a single long-lived session's raw log can reach
 * hundreds of MiB on its own.
 *
 * So this pass ignores the index for *what* to delete and trusts the
 * filesystem: in each candidate dir, any `<pid>.*.log` whose pid is no longer
 * running and whose mtime is outside the retention window. Guards:
 *
 * - the name must parse as a pid log (never `inbox.jsonl`, `pid.sqlite`, …);
 * - `isProcessAlive(pid)` must be false — pid reuse can only make a dead pid
 *   look alive, which keeps a file that a later run collects, never the
 *   reverse;
 * - mtime, not `started_at`, bounds the age, so a log still being appended to
 *   is safe even when its session started long ago.
 *
 * Best-effort; never throws.
 */
export async function sweepOrphanLogs(maxAgeMs: number = retentionMs()): Promise<LogGcResult> {
  const result: LogGcResult = { removed: [], freedBytes: 0 };
  let records: GlobalPidRecord[] = [];
  try {
    records = await readGlobalPidsRaw();
  } catch {
    // No index at all — the cwd is still worth sweeping.
  }
  const now = Date.now();

  for (const dir of candidateLogDirs(records)) {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // dir gone / unreadable — nothing to collect here
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = PID_LOG_FILE.exec(entry.name);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isInteger(pid) || pid <= 0 || isProcessAlive(pid)) continue;

      const file = path.join(dir, entry.name);
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(file)).mtimeMs;
      } catch {
        continue; // raced with deletion
      }
      if (now - mtimeMs <= maxAgeMs) continue; // still inside the window

      const freed = await removeLogFile(file);
      if (freed === null) continue;
      result.removed.push(file);
      result.freedBytes += freed;
    }
  }

  if (result.removed.length > 0) {
    logger.debug(`[globalPidIndex] swept ${result.removed.length} orphaned log file(s)`);
  }
  return result;
}

/**
 * The full log reclaim `ay gc` runs: the index-driven retention pass first
 * (it also compacts the index), then the directory sweep for whatever the
 * index no longer remembers. Paths are deduped, so a file both passes could
 * claim is only counted once.
 */
export async function gcLogs(maxAgeMs: number = retentionMs()): Promise<LogGcResult> {
  const pruned = await pruneOldLogsDetailed(maxAgeMs);
  const swept = await sweepOrphanLogs(maxAgeMs);
  const seen = new Set(pruned.removed);
  const result: LogGcResult = { ...pruned };
  for (const f of swept.removed) {
    if (seen.has(f)) continue;
    seen.add(f);
    result.removed.push(f);
  }
  result.freedBytes = pruned.freedBytes + swept.freedBytes;
  return result;
}
