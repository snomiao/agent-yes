/**
 * `cy ls / read / cat / tail / head / send` subcommand implementations.
 *
 * Mirrors the principles of koho's `terminal-ws-lib.ts` (session list, render
 * via @xterm/headless, keyword-keyed input) — but file-based instead of via
 * a daemon. Reads ~/.agent-yes/pids.jsonl (cross-runtime global index, written
 * by both the TS PidStore and the Rust pid_store::PidStore) and the per-pid
 * raw log files.
 *
 * Returns null when argv[2] is not a known subcommand so cli.ts falls through
 * to the normal agent-spawning flow.
 */

import { readFile, stat } from "fs/promises";
import { homedir } from "os";
import path from "path";
import { type GlobalPidRecord, readGlobalPids } from "./globalPidIndex.ts";

/**
 * Read the per-cwd TS PidStore JSONL and convert to the global record shape,
 * so pre-existing TS agents that were spawned before the global-index mirror
 * shipped still show up in `cy ls`. Merging is done in `mergeRecords`.
 */
async function readLocalTsPids(cwd: string): Promise<GlobalPidRecord[]> {
  const jsonlPath = path.join(cwd, ".agent-yes", "pid-records.jsonl");
  let raw: string;
  try {
    raw = await readFile(jsonlPath, "utf-8");
  } catch {
    return [];
  }

  // Same merge semantics as ts/JsonlStore.ts: last line per _id wins,
  // tombstones (`$$deleted`) drop the entry.
  const docs = new Map<string, any>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const doc = JSON.parse(trimmed);
      if (!doc._id) continue;
      if (doc.$$deleted) {
        docs.delete(doc._id);
        continue;
      }
      const prev = docs.get(doc._id);
      docs.set(doc._id, prev ? { ...prev, ...doc } : doc);
    } catch {
      // skip corrupt
    }
  }

  return Array.from(docs.values()).map((d) => ({
    pid: d.pid,
    cli: d.cli,
    prompt: d.prompt ?? null,
    cwd: d.cwd,
    log_file: d.logFile ?? null,
    fifo_file: d.fifoFile ?? null,
    status: d.status ?? "active",
    exit_code: d.exitCode ?? null,
    exit_reason: d.exitReason ?? null,
    started_at: d.startedAt ?? 0,
  }));
}

/** Merge by pid; later entries (typically from the global file) win. */
function mergeRecords(...buckets: GlobalPidRecord[][]): GlobalPidRecord[] {
  const out = new Map<number, GlobalPidRecord>();
  for (const bucket of buckets) {
    for (const r of bucket) {
      const prev = out.get(r.pid);
      out.set(r.pid, prev ? { ...prev, ...r } : r);
    }
  }
  return Array.from(out.values());
}

const SUBCOMMANDS = new Set(["ls", "list", "ps", "read", "cat", "tail", "head", "send", "restart"]);

export function isSubcommand(name: string | undefined): boolean {
  return !!name && SUBCOMMANDS.has(name);
}

/**
 * Top-level entry. Returns the desired process exit code, or null if argv
 * is not a subcommand invocation.
 */
export async function runSubcommand(argv: string[]): Promise<number | null> {
  const sub = argv[2];
  if (!isSubcommand(sub)) return null;

  const rest = argv.slice(3);

  try {
    switch (sub) {
      case "ls":
      case "list":
      case "ps":
        return await cmdLs(rest);
      case "read":
      case "cat":
        return await cmdRead(rest, { mode: "cat" });
      case "tail":
        return await cmdRead(rest, { mode: "tail" });
      case "head":
        return await cmdRead(rest, { mode: "head" });
      case "send":
        return await cmdSend(rest);
      case "restart":
        return await cmdRestart(rest);
      default:
        return null;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`cy ${sub}: ${msg}\n`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

interface CommonOpts {
  all: boolean;
  active: boolean;
  cwdScope: string | null;
  latest: boolean;
  json: boolean;
}

interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positional: string[];
}

export function parseArgs(rest: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = rest[i + 1];
        // Boolean flags: --all, --json, --latest
        if (
          ["all", "active", "follow", "json", "latest"].includes(key) ||
          !next ||
          next.startsWith("-")
        ) {
          flags[key] = true;
        } else {
          flags[key] = next;
          i++;
        }
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      // -n N short flag
      if (arg === "-n") {
        flags["n"] = rest[i + 1] ?? "";
        i++;
      } else {
        flags[arg.slice(1)] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function commonOpts(flags: Record<string, string | boolean>): CommonOpts {
  return {
    all: !!flags.all,
    active: !!flags.active,
    cwdScope:
      typeof flags.cwd === "string"
        ? path.resolve(flags.cwd)
        : flags.cwd === true
          ? process.cwd()
          : null,
    latest: !!flags.latest,
    json: !!flags.json,
  };
}

export function matchKeyword(record: GlobalPidRecord, keyword: string): boolean {
  if (!keyword) return true;
  const kw = keyword.toLowerCase();
  // 1. exact pid
  if (/^\d+$/.test(keyword) && record.pid === Number(keyword)) return true;
  // 2. cwd contains keyword
  if (record.cwd.toLowerCase().includes(kw)) return true;
  // 3. cli exact (lowercase)
  if (record.cli.toLowerCase() === kw) return true;
  // 4. prompt substring
  if (record.prompt && record.prompt.toLowerCase().includes(kw)) return true;
  return false;
}

async function listRecords(
  keyword: string | undefined,
  opts: CommonOpts,
): Promise<GlobalPidRecord[]> {
  // Read both sources: global cross-runtime index (Rust + new TS) and the
  // per-cwd TS file in process.cwd() (catches pre-existing TS agents that
  // started before the global mirror shipped). Optional --cwd <dir> adds
  // that directory's per-cwd file too.
  const local = await readLocalTsPids(process.cwd());
  const scopeLocal = opts.cwdScope ? await readLocalTsPids(opts.cwdScope) : [];
  const global = await readGlobalPids(); // raw, will filter below
  let records = mergeRecords(local, scopeLocal, global);

  if (!opts.all) {
    records = records.filter((r) => r.status !== "exited");
  }
  if (opts.active) {
    records = records.filter((r) => isPidAlive(r.pid));
  }
  if (opts.cwdScope) {
    const scope = opts.cwdScope;
    records = records.filter((r) => r.cwd === scope || r.cwd.startsWith(scope + path.sep));
  }
  if (keyword) records = records.filter((r) => matchKeyword(r, keyword));
  // newest first
  records.sort((a, b) => b.started_at - a.started_at);
  return records;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function resolveOne(keyword: string | undefined, opts: CommonOpts): Promise<GlobalPidRecord> {
  if (!keyword) {
    throw new Error("keyword required (pid, cwd substring, cli name, or prompt substring)");
  }
  const matches = await listRecords(keyword, opts);
  if (matches.length === 0) {
    throw new Error(`no agent matched "${keyword}"`);
  }
  if (matches.length === 1) return matches[0]!;
  if (opts.latest) return matches[0]!; // already sorted newest-first
  const lines = matches
    .slice(0, 10)
    .map((r) => `  ${r.pid}  ${r.cli}  ${r.cwd}`)
    .join("\n");
  throw new Error(
    `keyword "${keyword}" matched ${matches.length} agents — disambiguate by pid or pass --latest:\n${lines}`,
  );
}

// ---------------------------------------------------------------------------
// cy ls
// ---------------------------------------------------------------------------

async function cmdLs(rest: string[]): Promise<number> {
  const { flags, positional } = parseArgs(rest);
  const opts = commonOpts(flags);
  const keyword = positional[0];
  const records = await listRecords(keyword, opts);

  if (opts.json) {
    process.stdout.write(JSON.stringify(records, null, 2) + "\n");
    return 0;
  }

  if (records.length === 0) {
    process.stderr.write(
      keyword ? `no running agents matched "${keyword}"\n` : "no running agents\n",
    );
    return 0;
  }

  // Budget the trailing PROMPT column to whatever space is left in the
  // terminal after the fixed columns, so users on wide terminals see more
  // context and users on narrow ones don't get an awkwardly-wrapped table.
  const termWidth = (process.stdout as any).columns ?? 120;

  const rawCwds = records.map((r) => shortenPath(r.cwd));
  const widths = {
    pid: Math.max(3, ...records.map((r) => String(r.pid).length)),
    cli: Math.max(3, ...records.map((r) => r.cli.length)),
    status: Math.max(6, ...records.map((r) => r.status.length)),
    age: Math.max(3, ...records.map((r) => humanizeAge(Date.now() - r.started_at).length)),
    cwd: Math.max(3, ...rawCwds.map((c) => c.length)),
  };
  const fixedWidth = widths.pid + widths.cli + widths.status + widths.age + widths.cwd + 5 * 2; // 5 separators of "  "
  const promptBudget = Math.max(20, termWidth - fixedWidth - 1);

  const IDLE_THRESHOLD_MS = 60 * 1000;
  const rows = await Promise.all(
    records.map(async (r) => {
      let displayStatus: string;
      if (!isPidAlive(r.pid)) {
        displayStatus = "stopped";
      } else if (r.log_file) {
        const mtime = await stat(r.log_file)
          .then((s) => s.mtimeMs)
          .catch(() => null);
        displayStatus =
          mtime !== null && Date.now() - mtime > IDLE_THRESHOLD_MS ? "idle" : "active";
      } else {
        displayStatus = "active";
      }
      return {
        pid: String(r.pid),
        cli: r.cli,
        status: displayStatus,
        age: humanizeAge(Date.now() - r.started_at),
        cwd: shortenPath(r.cwd),
        prompt: truncate(r.prompt ?? "", promptBudget),
        _alive: displayStatus !== "stopped",
      };
    }),
  );

  const header =
    [
      "PID".padEnd(widths.pid),
      "CLI".padEnd(widths.cli),
      "STATUS".padEnd(widths.status),
      "AGE".padEnd(widths.age),
      "CWD".padEnd(widths.cwd),
      "PROMPT",
    ].join("  ") + "\n";
  process.stdout.write(header);

  for (const r of rows) {
    process.stdout.write(
      [
        r.pid.padEnd(widths.pid),
        r.cli.padEnd(widths.cli),
        r.status.padEnd(widths.status),
        r.age.padEnd(widths.age),
        r.cwd.padEnd(widths.cwd),
        r.prompt,
      ].join("  ") + "\n",
    );
  }

  if (!opts.json && rows.length > 0) {
    const alive = rows.find((r) => r._alive);
    const stopped = rows.find((r) => !r._alive);
    const hints: string[] = ["\n"];
    if (alive) {
      hints.push(`  cy tail ${alive.pid}                  # view latest output\n`);
      hints.push(`  cy tail -f ${alive.pid}               # follow live output\n`);
      hints.push(`  cy send ${alive.pid} "next: ..."      # send a prompt\n`);
      hints.push(`  cy send ${alive.pid} "" --code=ctrl-c # interrupt\n`);
    }
    if (stopped) {
      hints.push(`  cy restart ${stopped.pid}             # restart stopped agent\n`);
    }
    if (!alive && !stopped)
      hints.push(`  cy ls --all                          # show exited agents\n`);
    process.stderr.write(hints.join(""));
  }

  return 0;
}

function humanizeAge(ms: number): string {
  if (ms < 1000) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function shortenPath(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

// ---------------------------------------------------------------------------
// cy read / cat / tail / head
// ---------------------------------------------------------------------------

interface ReadOpts {
  mode: "cat" | "tail" | "head";
}

async function cmdRead(rest: string[], { mode }: ReadOpts): Promise<number> {
  const { flags, positional } = parseArgs(rest);
  const opts = commonOpts(flags);
  const keyword = positional[0];
  const follow = !!(flags.f || flags.follow);

  const nFlag = typeof flags.n === "string" ? Number(flags.n) : undefined;
  const n =
    nFlag !== undefined && Number.isFinite(nFlag) && nFlag > 0
      ? Math.floor(nFlag)
      : mode === "cat"
        ? 0
        : 96;

  const record = await resolveOne(keyword, opts);
  const logPath = record.log_file;
  if (!logPath) {
    throw new Error(`pid ${record.pid}: no log_file recorded`);
  }

  let stats;
  try {
    stats = await stat(logPath);
  } catch {
    throw new Error(`pid ${record.pid}: log file not found at ${logPath}`);
  }
  if (!stats.isFile()) {
    throw new Error(`pid ${record.pid}: log path is not a file: ${logPath}`);
  }

  const buf = await readFile(logPath);
  const rendered = await renderRawLog(buf, { mode, n });
  process.stderr.write(`[pid ${record.pid}  ${shortenPath(record.cwd)}]\n`);
  process.stdout.write(rendered);
  if (!rendered.endsWith("\n")) process.stdout.write("\n");

  if (follow) {
    process.stderr.write(`following... (Ctrl-C to stop)\n`);
    let offset = buf.length;
    const { watch } = await import("fs");
    // oxlint-disable-next-line no-control-regex -- intentional: strip ANSI/control
    const ansiRe = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
    // oxlint-disable-next-line no-control-regex -- intentional: strip control chars
    const ctrlRe = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
    await new Promise<void>((resolve) => {
      const watcher = watch(logPath, async () => {
        const full = await readFile(logPath);
        if (full.length <= offset) return;
        const chunk = full.slice(offset);
        offset = full.length;
        const text = new TextDecoder().decode(chunk).replace(ansiRe, "").replace(ctrlRe, "");
        if (text.trim()) process.stdout.write(text.trimStart());
      });
      process.on("SIGINT", () => {
        watcher.close();
        resolve();
      });
    });
    return 0;
  }

  process.stderr.write(
    `\n` +
      `  cy ls                                 # list all agents\n` +
      `  cy tail -f ${record.pid}              # follow live output\n` +
      `  cy send ${record.pid} "next: ..."      # send a prompt\n` +
      `  cy send ${record.pid} "" --code=ctrl-c # interrupt\n`,
  );
  return 0;
}

/**
 * Feed the raw PTY bytes through @xterm/headless and emit plain text.
 * Same approach as koho's renderTerminalBuffer + agent-yes's XtermProxy.
 */
async function renderRawLog(
  buf: Uint8Array,
  { mode, n }: { mode: "cat" | "tail" | "head"; n: number },
): Promise<string> {
  // Default screen geometry — we don't know what the agent used, but
  // 200x50 is a reasonable upper bound that won't truncate normal output.
  const cols = 200;
  const rows = 50;
  // Scrollback must hold enough lines for the requested slice.
  const scrollback = Math.max(50000, n + rows + 100);

  try {
    const xtermPkg = await import("@xterm/headless");
    const { Terminal } = xtermPkg;
    const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    await new Promise<void>((resolve) => term.write(buf, resolve));
    const active = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < active.length; i++) {
      const line = active.getLine(i);
      lines.push(line ? line.translateToString(false).trimEnd() : "");
    }
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    if (mode === "cat") return lines.join("\n");
    if (mode === "tail") return lines.slice(Math.max(0, lines.length - n)).join("\n");
    return lines.slice(0, n).join("\n");
  } catch {
    // Fallback: regex strip ANSI
    let text = new TextDecoder().decode(buf);
    // oxlint-disable-next-line no-control-regex -- intentional: strip ANSI
    const ansi = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
    // oxlint-disable-next-line no-control-regex -- intentional: strip control
    const ctrl = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
    text = text.replace(ansi, "").replace(ctrl, "");
    const lines = text.split("\n");
    if (mode === "cat") return lines.join("\n");
    if (mode === "tail") return lines.slice(Math.max(0, lines.length - n)).join("\n");
    return lines.slice(0, n).join("\n");
  }
}

// ---------------------------------------------------------------------------
// cy send
// ---------------------------------------------------------------------------

async function cmdSend(rest: string[]): Promise<number> {
  const { flags, positional } = parseArgs(rest);
  const opts = commonOpts(flags);
  const keyword = positional[0];
  const rawMessage = positional.slice(1).join(" ");

  if (!keyword)
    throw new Error("usage: cy send <keyword> <msg|-> [--code=enter|esc|ctrl-c|ctrl-y|tab|none]");

  const codeName = typeof flags.code === "string" ? flags.code.toLowerCase() : "enter";
  const trailing = controlCodeFromName(codeName);

  const record = await resolveOne(keyword, opts);
  const fifoPath = record.fifo_file;
  if (!fifoPath) {
    throw new Error(
      `pid ${record.pid}: no fifo_file recorded — agent was not started with --stdpush (or was spawned by Rust which doesn't yet support FIFO IPC; see ROADMAP item 10)`,
    );
  }

  let body: string;
  if (rawMessage === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    body = Buffer.concat(chunks).toString("utf-8").trimEnd();
  } else {
    body = rawMessage;
  }

  if (body && trailing) {
    await writeToIpc(fifoPath, body);
    await new Promise((r) => setTimeout(r, 200));
    await writeToIpc(fifoPath, trailing);
  } else {
    await writeToIpc(fifoPath, body + trailing);
  }
  const payload = body + trailing;
  process.stdout.write(`sent to pid ${record.pid} (${record.cli}): ${truncate(payload, 80)}\n`);

  process.stderr.write(
    `\n` +
      `  cy tail ${record.pid}                  # watch output\n` +
      `  cy ls                                  # list all agents\n`,
  );
  return 0;
}

export function controlCodeFromName(name: string): string {
  switch (name) {
    case "enter":
    case "cr":
    case "return":
      return "\r";
    case "esc":
    case "escape":
      return "\x1b";
    case "ctrl-c":
    case "ctrlc":
      return "\x03";
    case "ctrl-y":
    case "ctrly":
      return "\x19";
    case "ctrl-d":
    case "ctrld":
      return "\x04";
    case "tab":
      return "\t";
    case "none":
    case "":
      return "";
    default:
      // raw:0xNN form
      const m = /^raw:0x([0-9a-f]+)$/i.exec(name);
      if (m) return String.fromCharCode(parseInt(m[1]!, 16));
      throw new Error(`unknown --code=${name}`);
  }
}

async function writeToIpc(ipcPath: string, payload: string): Promise<void> {
  if (process.platform === "win32") {
    const { connect } = await import("net");
    await new Promise<void>((resolve, reject) => {
      const client = connect(ipcPath);
      const timer = setTimeout(() => {
        client.destroy();
        reject(new Error("named pipe connect timeout"));
      }, 5000);
      client.on("connect", () => {
        clearTimeout(timer);
        client.write(payload);
        client.end();
        resolve();
      });
      client.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } else {
    const { openSync, writeFileSync, closeSync } = await import("fs");
    const fd = openSync(ipcPath, "w");
    try {
      writeFileSync(fd, payload);
    } finally {
      closeSync(fd);
    }
  }
}

// ---------------------------------------------------------------------------
// cy restart
// ---------------------------------------------------------------------------

async function cmdRestart(rest: string[]): Promise<number> {
  const { flags, positional } = parseArgs(rest);
  const opts = { ...commonOpts(flags), all: true }; // search stopped agents too
  const keyword = positional[0];
  const record = await resolveOne(keyword, opts);

  if (isPidAlive(record.pid)) {
    process.stderr.write(`pid ${record.pid} is still running — stop it first or use cy send\n`);
    return 1;
  }

  const args = ["--cli=" + record.cli];
  if (record.prompt) args.push(record.prompt);

  const proc = Bun.spawn(["agent-yes", ...args], {
    cwd: record.cwd,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });

  process.stdout.write(
    `restarted ${record.cli} in ${shortenPath(record.cwd)} (new pid: ${proc.pid})\n`,
  );
  process.stderr.write(
    `\n` +
      `  cy tail ${proc.pid}   # watch output\n` +
      `  cy ls                 # list all agents\n`,
  );
  return 0;
}
