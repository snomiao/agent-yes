/**
 * `ay ls / read / cat / tail / head / send` subcommand implementations.
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

import { appendFile, mkdir, open, readFile, stat, writeFile } from "fs/promises";
import ms from "ms";
import { homedir } from "os";
import path from "path";
import { type GlobalPidRecord, readGlobalPids } from "./globalPidIndex.ts";
import yargs from "yargs";
import { type ResolvedRemote, readRemotes, resolveRemoteSpec } from "./remotes.ts";

// ---------------------------------------------------------------------------
// notes store  (~/.agent-yes/notes.jsonl)
// ---------------------------------------------------------------------------

function notesPath(): string {
  const dir = process.env.AGENT_YES_HOME ?? path.join(homedir(), ".agent-yes");
  return path.join(dir, "notes.jsonl");
}

export async function readNotes(): Promise<Map<number, string>> {
  let raw: string;
  try {
    raw = await readFile(notesPath(), "utf-8");
  } catch {
    return new Map();
  }
  const map = new Map<number, string>();
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const { pid, note } = JSON.parse(t);
      if (typeof pid === "number") {
        if (note) map.set(pid, note);
        else map.delete(pid);
      }
    } catch {
      /* skip */
    }
  }
  return map;
}

async function writeNote(pid: number, note: string): Promise<void> {
  const p = notesPath();
  await mkdir(path.dirname(p), { recursive: true });
  await appendFile(p, JSON.stringify({ pid, note, updated_at: Date.now() }) + "\n");
}

async function compactNotes(): Promise<void> {
  const map = await readNotes();
  const lines = Array.from(map.entries())
    .map(([pid, note]) => JSON.stringify({ pid, note, updated_at: Date.now() }))
    .join("\n");
  await writeFile(notesPath(), lines ? lines + "\n" : "");
}

/**
 * Read the per-cwd TS PidStore JSONL and convert to the global record shape,
 * so pre-existing TS agents that were spawned before the global-index mirror
 * shipped still show up in `ay ls`. Merging is done in `mergeRecords`.
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

const SUBCOMMANDS = new Set([
  "ls",
  "list",
  "ps",
  "status",
  "read",
  "cat",
  "tail",
  "head",
  "send",
  "restart",
  "note",
  "serve",
  "remote",
]);

const IDLE_THRESHOLD_MS = 60 * 1000;

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
      case "status":
        return await cmdStatus(rest);
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
      case "note":
        return await cmdNote(rest);
      case "serve": {
        const { cmdServe } = await import("./serve.ts");
        return cmdServe(rest);
      }
      case "remote": {
        const { cmdRemote } = await import("./remotes.ts");
        return cmdRemote(rest);
      }
      default:
        return null;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ay ${sub}: ${msg}\n`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

export interface CommonOpts {
  all: boolean;
  active: boolean;
  cwdScope: string | null;
  latest: boolean;
  json: boolean;
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

export async function listRecords(
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

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function resolveOne(
  keyword: string | undefined,
  opts: CommonOpts,
): Promise<GlobalPidRecord> {
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
// remote routing helpers
// ---------------------------------------------------------------------------

async function remoteGet(remote: ResolvedRemote, pathname: string): Promise<Response> {
  return fetch(`${remote.url}${pathname}`, {
    headers: { Authorization: `Bearer ${remote.token}` },
  });
}

async function remotePost(
  remote: ResolvedRemote,
  pathname: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${remote.url}${pathname}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${remote.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function runRemoteLs(
  remote: ResolvedRemote,
  opts: { all: boolean; active: boolean },
): Promise<number> {
  const params = new URLSearchParams();
  if (remote.keyword) params.set("keyword", remote.keyword);
  if (opts.all) params.set("all", "1");
  if (opts.active) params.set("active", "1");
  const res = await remoteGet(remote, `/api/ls?${params}`);
  if (!res.ok) {
    process.stderr.write(`remote error ${res.status}: ${await res.text()}\n`);
    return 1;
  }
  const records = (await res.json()) as any[];
  if (records.length === 0) {
    process.stderr.write(
      remote.keyword
        ? `no agents matched "${remote.keyword}" on ${remote.url}\n`
        : `no running agents on ${remote.url}\n`,
    );
    return 0;
  }
  process.stderr.write(`[remote ${remote.url}]\n`);
  const termWidth = (process.stdout as any).columns ?? 120;
  const widths = {
    pid: Math.max(3, ...records.map((r: any) => String(r.pid).length)),
    cli: Math.max(3, ...records.map((r: any) => String(r.cli).length)),
    status: Math.max(6, ...records.map((r: any) => String(r.status).length)),
    cwd: Math.max(3, ...records.map((r: any) => String(r.cwd).length)),
  };
  const fixedWidth = widths.pid + widths.cli + widths.status + widths.cwd + 4 * 2;
  const promptBudget = Math.max(20, termWidth - fixedWidth - 1);
  const header =
    [
      "PID".padEnd(widths.pid),
      "CLI".padEnd(widths.cli),
      "STATUS".padEnd(widths.status),
      "CWD".padEnd(widths.cwd),
      "PROMPT",
    ].join("  ") + "\n";
  process.stdout.write(header);
  for (const r of records) {
    const label = r.prompt ? truncate(`→ ${r.prompt}`, promptBudget) : "";
    process.stdout.write(
      [
        String(r.pid).padEnd(widths.pid),
        String(r.cli).padEnd(widths.cli),
        String(r.status).padEnd(widths.status),
        String(r.cwd).padEnd(widths.cwd),
        label,
      ].join("  ") + "\n",
    );
  }
  return 0;
}

async function runRemoteRead(
  remote: ResolvedRemote,
  mode: "cat" | "tail" | "head",
  follow: boolean,
  n: number,
  reconnectTimeoutMs = 120_000,
): Promise<number> {
  const keyword = remote.keyword ?? "";
  if (!keyword) {
    process.stderr.write(
      "remote tail/cat/head requires a keyword (e.g. token@host:port:keyword)\n",
    );
    return 1;
  }

  if (mode === "tail" && follow) {
    const ac = new AbortController();
    process.on("SIGINT", () => ac.abort());
    const deadline = Date.now() + reconnectTimeoutMs;
    let delay = 1_000;
    let attempt = 0;

    process.stderr.write(
      `[remote ${remote.url}  ${keyword}]\nfollowing... (Ctrl-C to stop, timeout: ${Math.round(reconnectTimeoutMs / 1000)}s)\n`,
    );

    while (!ac.signal.aborted) {
      try {
        const res = await fetch(`${remote.url}/api/tail/${encodeURIComponent(keyword)}`, {
          headers: { Authorization: `Bearer ${remote.token}`, Accept: "text/event-stream" },
          signal: ac.signal,
        });
        if (!res.ok) {
          // 401/404 are permanent failures — no point retrying
          if (res.status === 401 || res.status === 404) {
            process.stderr.write(`remote error ${res.status}: ${await res.text()}\n`);
            return 1;
          }
          throw new Error(`HTTP ${res.status}`);
        }

        if (attempt > 0) process.stderr.write("remote: reconnected\n");
        delay = 1_000; // reset backoff on successful connect

        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const text = JSON.parse(line.slice(6)) as string;
              process.stdout.write(text);
              if (!text.endsWith("\n")) process.stdout.write("\n");
            } catch {
              /* skip non-JSON */
            }
          }
        }
        break; // stream ended cleanly
      } catch (e: any) {
        if (e.name === "AbortError" || ac.signal.aborted) return 0;
        if (Date.now() >= deadline) {
          process.stderr.write(
            `remote: timeout after ${Math.round(reconnectTimeoutMs / 1000)}s, giving up\n`,
          );
          return 1;
        }
        process.stderr.write(
          `remote: disconnected (${e.message}), retrying in ${delay / 1000}s…\n`,
        );
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, delay);
          ac.signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("abort"));
          });
        }).catch(() => {});
        if (ac.signal.aborted) return 0;
        delay = Math.min(delay * 2, 30_000);
        attempt++;
      }
    }
    return 0;
  }

  // Static read (cat/head/tail without -f)
  const params = new URLSearchParams({ mode, n: String(n) });
  const res = await remoteGet(remote, `/api/read/${encodeURIComponent(keyword)}?${params}`);
  if (!res.ok) {
    process.stderr.write(`remote error ${res.status}: ${await res.text()}\n`);
    return 1;
  }
  const text = await res.text();
  process.stderr.write(`[remote ${remote.url}  ${keyword}]\n`);
  process.stdout.write(text);
  if (!text.endsWith("\n")) process.stdout.write("\n");
  return 0;
}

async function runRemoteSend(remote: ResolvedRemote, msg: string, code: string): Promise<number> {
  const keyword = remote.keyword ?? "";
  if (!keyword) {
    process.stderr.write("remote send requires a keyword (e.g. token@host:port:keyword)\n");
    return 1;
  }
  const res = await remotePost(remote, "/api/send", { keyword, msg, code });
  if (!res.ok) {
    process.stderr.write(`remote error ${res.status}: ${await res.text()}\n`);
    return 1;
  }
  const data = (await res.json()) as any;
  process.stdout.write(`sent to remote pid ${data.pid} (${remote.url}  ${keyword})\n`);
  return 0;
}

async function runRemoteStatus(remote: ResolvedRemote): Promise<number> {
  const keyword = remote.keyword ?? "";
  if (!keyword) {
    process.stderr.write("remote status requires a keyword (e.g. token@host:port:keyword)\n");
    return 1;
  }
  const res = await remoteGet(remote, `/api/status/${encodeURIComponent(keyword)}`);
  if (!res.ok) {
    process.stderr.write(`remote error ${res.status}: ${await res.text()}\n`);
    return 1;
  }
  process.stdout.write(JSON.stringify(await res.json(), null, 2) + "\n");
  return 0;
}

// ---------------------------------------------------------------------------
// --all-remotes helpers
// ---------------------------------------------------------------------------

async function fetchRemoteRecordsRaw(
  url: string,
  token: string,
  opts: { all: boolean; active: boolean; keyword?: string },
): Promise<any[]> {
  const params = new URLSearchParams();
  if (opts.all) params.set("all", "1");
  if (opts.active) params.set("active", "1");
  if (opts.keyword) params.set("keyword", opts.keyword);
  try {
    const res = await fetch(`${url}/api/ls?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    return (await res.json()) as any[];
  } catch {
    return [];
  }
}

async function runAllRemotesLs(opts: {
  all: boolean;
  active: boolean;
  keyword?: string;
}): Promise<number> {
  const remotes = await readRemotes();
  const localOpts: CommonOpts = {
    all: opts.all,
    active: opts.active,
    json: true,
    latest: false,
    cwdScope: null,
  };

  const [localResult, ...remoteResults] = await Promise.allSettled([
    listRecords(opts.keyword, localOpts).then((recs) => ({
      host: "local",
      records: recs as any[],
    })),
    ...Array.from(remotes.entries()).map(([alias, cfg]) =>
      fetchRemoteRecordsRaw(cfg.url, cfg.token, opts).then((records) => ({ host: alias, records })),
    ),
  ]);

  type HostedRow = { host: string; rec: any };
  const rows: HostedRow[] = [];
  if (localResult.status === "fulfilled") {
    for (const r of localResult.value.records) rows.push({ host: "local", rec: r });
  }
  for (const res of remoteResults) {
    if (res.status === "fulfilled") {
      for (const r of res.value.records) rows.push({ host: res.value.host, rec: r });
    }
  }

  if (rows.length === 0) {
    process.stderr.write("no running agents\n");
    return 0;
  }

  const termWidth = (process.stdout as any).columns ?? 120;
  const hostW = Math.max(4, ...rows.map((r) => r.host.length));
  const pidW = Math.max(3, ...rows.map((r) => String(r.rec.pid).length));
  const cliW = Math.max(3, ...rows.map((r) => String(r.rec.cli).length));
  const statusW = Math.max(6, ...rows.map((r) => String(r.rec.status).length));
  const cwdW = Math.max(3, ...rows.map((r) => shortenPath(String(r.rec.cwd)).length));
  const promptBudget = Math.max(20, termWidth - hostW - pidW - cliW - statusW - cwdW - 5 * 2 - 1);

  process.stdout.write(
    [
      "HOST".padEnd(hostW),
      "PID".padEnd(pidW),
      "CLI".padEnd(cliW),
      "STATUS".padEnd(statusW),
      "CWD".padEnd(cwdW),
      "PROMPT",
    ].join("  ") + "\n",
  );
  for (const { host, rec } of rows) {
    const label = rec.prompt ? truncate(`→ ${rec.prompt}`, promptBudget) : "";
    process.stdout.write(
      [
        host.padEnd(hostW),
        String(rec.pid).padEnd(pidW),
        String(rec.cli).padEnd(cliW),
        String(rec.status).padEnd(statusW),
        shortenPath(String(rec.cwd)).padEnd(cwdW),
        label,
      ].join("  ") + "\n",
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------
// ay ls
// ---------------------------------------------------------------------------

async function cmdLs(rest: string[]): Promise<number> {
  const y = yargs(rest)
    .usage(
      "Usage: ay ls [keyword] [options]\n" +
        "       ay list [keyword] [options]\n" +
        "       ay ps   [keyword] [options]\n\n" +
        "List running agents. Optionally filter by keyword (pid, cwd substring, or prompt substring).",
    )
    .option("all", {
      type: "boolean",
      default: false,
      description: "Show all agents including exited ones",
    })
    .option("active", {
      type: "boolean",
      default: false,
      description: "Only show agents with an alive process",
    })
    .option("json", { type: "boolean", default: false, description: "Output as JSON array" })
    .option("latest", {
      type: "boolean",
      default: false,
      description: "Show only the most recent agent",
    })
    .option("cwd", { type: "string", description: "Restrict to agents whose cwd starts with dir" })
    .option("all-remotes", {
      type: "boolean",
      default: false,
      description: "Include agents from all configured remotes (remotes.yaml)",
    })
    .option("help", { alias: "h", type: "boolean", default: false, description: "Show this help" })
    .example("ay ls", "list running agents")
    .example("ay ls --all-remotes", "include all configured remote machines")
    .example("ay ls --all", "include exited agents")
    .example("ay ls --json", "machine-readable output")
    .example("ay ls symval", "filter by cwd/prompt keyword")
    .help(false)
    .version(false)
    .exitProcess(false);

  const argv = await y.parseAsync();

  if (argv.help || argv.h) {
    process.stdout.write((await y.getHelp()) + "\n");
    return 0;
  }

  if (argv["all-remotes"]) {
    return runAllRemotesLs({
      all: argv.all,
      active: argv.active,
      keyword: argv._[0] !== undefined ? String(argv._[0]) : undefined,
    });
  }

  const keyword = argv._[0] !== undefined ? String(argv._[0]) : undefined;
  if (keyword) {
    const remote = await resolveRemoteSpec(keyword);
    if (remote) return runRemoteLs(remote, { all: argv.all, active: argv.active });
  }
  const opts: CommonOpts = {
    all: argv.all,
    active: argv.active,
    json: argv.json,
    latest: argv.latest,
    cwdScope: typeof argv.cwd === "string" ? path.resolve(argv.cwd) : null,
  };
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

  const notes = await readNotes();
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
      const note = notes.get(r.pid);
      let label: string;
      let hasNote = false;
      if (note) {
        label = truncate(note, promptBudget);
        hasNote = true;
      } else if (r.log_file && displayStatus !== "stopped") {
        const activity = await extractActivity(r.log_file);
        label = truncate(activity ?? (r.prompt ? `→ ${r.prompt}` : ""), promptBudget);
      } else {
        label = truncate(r.prompt ? `→ ${r.prompt}` : "", promptBudget);
      }
      return {
        pid: String(r.pid),
        cli: r.cli,
        status: displayStatus,
        age: humanizeAge(Date.now() - r.started_at),
        cwd: shortenPath(r.cwd),
        label,
        hasNote,
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
      "NOTE/PROMPT",
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
        r.hasNote ? `* ${r.label}` : r.label,
      ].join("  ") + "\n",
    );
  }

  if (!opts.json && rows.length > 0) {
    const alive = rows.find((r) => r._alive);
    const stopped = rows.find((r) => !r._alive);
    const hints: string[] = ["\n"];
    if (alive) {
      hints.push(`  ay status ${alive.pid}                # JSON status snapshot\n`);
      hints.push(`  ay status ${alive.pid} --watch        # stream changes as JSON\n`);
      hints.push(`  ay status ${alive.pid} --wait-idle    # block until state == idle\n`);
      hints.push(`  ay tail ${alive.pid}                  # view latest output\n`);
      hints.push(`  ay tail -f ${alive.pid}               # follow live output\n`);
      hints.push(
        `  ay send ${alive.pid} "next: ..."      # send a prompt (keyword: pid, cwd, or prompt substring)\n`,
      );
      hints.push(`  ay send ${alive.pid} "" --code=ctrl-c # interrupt\n`);
      hints.push(`  ay note ${alive.pid} "what it's doing" # set a note\n`);
      hints.push(
        `  ay ls --json                           # machine-readable list for scripts/agents\n`,
      );
    }
    if (stopped) {
      hints.push(`  ay restart ${stopped.pid}             # restart stopped agent\n`);
    }
    if (!alive && !stopped)
      hints.push(`  ay ls --all                          # show exited agents\n`);
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
// ay read / cat / tail / head
// ---------------------------------------------------------------------------

interface ReadOpts {
  mode: "cat" | "tail" | "head";
}

async function cmdRead(rest: string[], { mode }: ReadOpts): Promise<number> {
  const y = yargs(rest)
    .usage("Usage: ay read/cat/tail/head <keyword> [options]")
    .option("follow", {
      alias: "f",
      type: "boolean",
      default: false,
      description: "Follow log output (Ctrl-C to stop)",
    })
    .option("n", { type: "number", description: "Number of lines (default: 96 for tail/head)" })
    .option("all", { type: "boolean", default: false, description: "Include exited agents" })
    .option("latest", {
      type: "boolean",
      default: false,
      description: "Use most recent match when multiple match",
    })
    .option("cwd", { type: "string", description: "Restrict to agents under this dir" })
    .option("reconnect-timeout", {
      type: "number",
      default: 120,
      description: "Seconds before giving up reconnecting remote SSE (default: 120)",
    })
    .help(false)
    .version(false)
    .exitProcess(false);

  const argv = await y.parseAsync();
  const opts: CommonOpts = {
    all: argv.all,
    active: false,
    json: false,
    latest: argv.latest,
    cwdScope: typeof argv.cwd === "string" ? path.resolve(argv.cwd) : null,
  };
  const keyword = argv._[0] !== undefined ? String(argv._[0]) : undefined;
  if (keyword) {
    const remote = await resolveRemoteSpec(keyword);
    const nFlag2 = argv.n;
    const n2 =
      nFlag2 !== undefined && Number.isFinite(nFlag2) && nFlag2 > 0
        ? Math.floor(nFlag2)
        : mode === "cat"
          ? 0
          : 96;
    const reconnectTimeoutMs = ((argv["reconnect-timeout"] as number) ?? 120) * 1000;
    if (remote) return runRemoteRead(remote, mode, argv.follow, n2, reconnectTimeoutMs);
  }
  const follow = argv.follow;
  const nFlag = argv.n;
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
  const notes = await readNotes();
  const noteLabel = notes.get(record.pid);
  const header = noteLabel
    ? `[pid ${record.pid}  ${shortenPath(record.cwd)}  * ${noteLabel}]`
    : `[pid ${record.pid}  ${shortenPath(record.cwd)}]`;
  process.stderr.write(header + "\n");
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
      `  ay ls                                 # list all agents\n` +
      `  ay tail -f ${record.pid}              # follow live output\n` +
      `  ay send ${record.pid} "next: ..."      # send a prompt\n` +
      `  ay send ${record.pid} "" --code=ctrl-c # interrupt\n`,
  );
  return 0;
}

/**
 * Feed the raw PTY bytes through @xterm/headless and emit plain text.
 * Same approach as koho's renderTerminalBuffer + agent-yes's XtermProxy.
 */
export async function renderRawLog(
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
// activity extraction
// ---------------------------------------------------------------------------

/**
 * Extract a one-line activity summary from a raw log file.
 * Reads only the last 32 KB for speed, renders via xterm for clean output.
 */
async function extractActivity(logPath: string): Promise<string | null> {
  const TAIL_BYTES = 32 * 1024;
  let buf: Uint8Array;
  try {
    const fh = await open(logPath, "r");
    try {
      const { size } = await fh.stat();
      if (size === 0) return null;
      if (size <= TAIL_BYTES) {
        const data = await fh.readFile();
        buf = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      } else {
        const tmp = Buffer.alloc(TAIL_BYTES);
        const { bytesRead } = await fh.read(tmp, 0, TAIL_BYTES, size - TAIL_BYTES);
        buf = new Uint8Array(tmp.buffer, 0, bytesRead);
      }
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }

  try {
    const rendered = await renderRawLog(buf, { mode: "tail", n: 40 });
    return extractActivityFromLines(rendered.split("\n"));
  } catch {
    return null;
  }
}

function extractActivityFromLines(lines: string[]): string | null {
  // Claude Code UI chrome: these lines carry no meaningful activity info
  const isChrome = (l: string): boolean => {
    const s = l.trim();
    return (
      !s ||
      /^─+$/.test(s) ||
      s.startsWith("? for shortcuts") ||
      /^esc to interrupt/i.test(s) ||
      /\d+%\s*until auto-compact/i.test(s) ||
      /^\/model\s+/i.test(s) ||
      /^⧉\s+In\s+/i.test(s) ||
      /^●\s+(high|medium|low)\s*[·•]/i.test(s) ||
      /^[·•]\s*\d+\s+(left|request)/i.test(s)
    );
  };

  const clean = lines.filter((l) => !isChrome(l));

  const isSpinnerLine = (l: string) =>
    /^[^\w\s❯>⎿✓✗]\s+[A-Z]\w+[….]/u.test(l.trim()) || /still thinking/i.test(l);

  // Find positions of the last ❯ prompt and last spinner in the rendered output.
  // If ❯ comes after the last spinner, the agent finished and is waiting — show
  // idle state rather than the stale spinner description.
  let lastPromptIdx = -1;
  let lastSpinnerIdx = -1;
  for (let i = clean.length - 1; i >= 0; i--) {
    const l = clean[i]!.trim();
    if (lastPromptIdx === -1 && l.startsWith("❯")) lastPromptIdx = i;
    if (lastSpinnerIdx === -1 && isSpinnerLine(l)) lastSpinnerIdx = i;
    if (lastPromptIdx !== -1 && lastSpinnerIdx !== -1) break;
  }

  // ❯ appears after (or without) any spinner → agent is idle/waiting for input
  if (lastPromptIdx > lastSpinnerIdx) {
    const text = clean[lastPromptIdx]!.trim()
      .replace(/^❯\s*/, "")
      .trim();
    return text ? `» ${text}` : null;
  }

  // Priority 1: thinking/composing spinner active
  // Claude Code cycles through various Unicode dingbats for its spinner (✢✳✶✻✷…).
  // The format is always: SPINNER_CHAR Verb… (timing…)
  // Require ellipsis after the verb so we don't false-positive on normal text
  // that happens to contain one of these chars mid-sentence.
  const thinkingLine = clean.find((l) => isSpinnerLine(l));
  if (thinkingLine) {
    const m = /^.\s+(\w+[^(]*)(?:\s*\(|$)/u.exec(thinkingLine.trim());
    return m?.[1] ? `✳ ${m[1].trim()}` : "thinking…";
  }

  // Priority 3: ✻ spinner just finished — show nearby context
  const cookIdx = clean.findIndex((l) => /^✻\s+/.test(l.trim()));
  if (cookIdx >= 0) {
    const window = clean.slice(Math.max(0, cookIdx - 8), cookIdx);
    for (let i = window.length - 1; i >= 0; i--) {
      const l = window[i]!.trim();
      if (l && !/^[✻✢⧉❯]/.test(l) && !isChrome(l)) {
        return l.length > 80 ? l.slice(0, 79) + "…" : l;
      }
    }
  }

  // Priority 4: last meaningful non-icon line
  for (let i = clean.length - 1; i >= 0; i--) {
    const l = clean[i]!.trim();
    // Skip lines that look like spinner patterns (caught by priority 1 above)
    // and status dots/separators; everything else (including ⎿ tool sub-output
    // and non-ASCII text like Japanese) is fair game as meaningful content.
    if (l && !/^[─●○◉⧉]/.test(l) && !/^[^\w\s❯>]\s+[A-Z]\w+[….]/u.test(l)) {
      return l.length > 80 ? l.slice(0, 79) + "…" : l;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// ay send
// ---------------------------------------------------------------------------

async function cmdSend(rest: string[]): Promise<number> {
  const y = yargs(rest)
    .usage("Usage: ay send <keyword> <msg|-> [options]")
    .option("code", {
      type: "string",
      default: "enter",
      description: "Trailing control code (enter|esc|ctrl-c|ctrl-y|tab|none)",
    })
    .option("all", { type: "boolean", default: false, description: "Include exited agents" })
    .option("latest", { type: "boolean", default: false, description: "Use most recent match" })
    .option("cwd", { type: "string", description: "Restrict to agents under this dir" })
    .help(false)
    .version(false)
    .exitProcess(false);

  const argv = await y.parseAsync();
  const opts: CommonOpts = {
    all: argv.all,
    active: false,
    json: false,
    latest: argv.latest,
    cwdScope: typeof argv.cwd === "string" ? path.resolve(argv.cwd) : null,
  };
  const keyword = argv._[0] !== undefined ? String(argv._[0]) : undefined;
  const rawMessage = argv._.slice(1).map(String).join(" ");

  if (!keyword)
    throw new Error("usage: ay send <keyword> <msg|-> [--code=enter|esc|ctrl-c|ctrl-y|tab|none]");

  const codeName = argv.code.toLowerCase();
  {
    const remote = await resolveRemoteSpec(keyword);
    if (remote) return runRemoteSend(remote, rawMessage, codeName);
  }
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

  const sourcePid = process.env.AGENT_YES_PID ? Number(process.env.AGENT_YES_PID) : null;
  const talkBack = sourcePid
    ? `\n(from AGENT_YES_PID=${sourcePid} — reply: ay send ${sourcePid} "...")`
    : "";

  const fullBody = body + talkBack;
  if (fullBody && trailing) {
    await writeToIpc(fifoPath, fullBody);
    await new Promise((r) => setTimeout(r, 200));
    await writeToIpc(fifoPath, trailing);
  } else {
    await writeToIpc(fifoPath, fullBody + trailing);
  }
  const payload = body + trailing;
  process.stdout.write(`sent to pid ${record.pid} (${record.cli}): ${truncate(payload, 80)}\n`);

  const replyHint = sourcePid
    ? `  ay send ${sourcePid} "..."              # reply to sender\n`
    : "";
  process.stderr.write(
    `\n` +
      replyHint +
      `  ay tail ${record.pid}                  # watch output\n` +
      `  ay ls                                  # list all agents\n`,
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

export async function writeToIpc(ipcPath: string, payload: string): Promise<void> {
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
// ay restart
// ---------------------------------------------------------------------------

async function cmdRestart(rest: string[]): Promise<number> {
  const y = yargs(rest)
    .usage("Usage: ay restart <keyword>")
    .option("latest", { type: "boolean", default: false, description: "Use most recent match" })
    .option("cwd", { type: "string", description: "Restrict to agents under this dir" })
    .help(false)
    .version(false)
    .exitProcess(false);

  const argv = await y.parseAsync();
  const opts: CommonOpts = {
    all: true,
    active: false,
    json: false,
    latest: argv.latest,
    cwdScope: typeof argv.cwd === "string" ? path.resolve(argv.cwd) : null,
  };
  const keyword = argv._[0] !== undefined ? String(argv._[0]) : undefined;
  const record = await resolveOne(keyword, opts);

  if (isPidAlive(record.pid)) {
    process.stderr.write(`pid ${record.pid} is still running — stop it first or use ay send\n`);
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
      `  ay tail ${proc.pid}   # watch output\n` +
      `  ay ls                 # list all agents\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// ay note
// ---------------------------------------------------------------------------

async function cmdNote(rest: string[]): Promise<number> {
  const y = yargs(rest)
    .usage('Usage: ay note <keyword> ["note text"]')
    .help(false)
    .version(false)
    .exitProcess(false);

  const argv = await y.parseAsync();
  const keyword = argv._[0] !== undefined ? String(argv._[0]) : undefined;
  const note = argv._.slice(1).map(String).join(" ");

  if (!keyword) throw new Error('usage: ay note <keyword> ["note text"]  (omit text to clear)');

  const record = await resolveOne(keyword, {
    all: true,
    active: false,
    json: false,
    latest: false,
    cwdScope: null,
  });

  if (!note) {
    // clear
    await writeNote(record.pid, "");
    await compactNotes();
    process.stdout.write(`cleared note for pid ${record.pid}\n`);
    return 0;
  }

  await writeNote(record.pid, note);
  process.stdout.write(`note set for pid ${record.pid}: ${note}\n`);
  process.stderr.write(`\n  ay ls   # see updated note in list\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// ay status
// ---------------------------------------------------------------------------

export interface StatusSnapshot {
  pid: number;
  cli: string;
  cwd: string;
  state: "active" | "idle" | "stopped";
  activity: string | null;
  note: string | null;
  log_mtime_ms: number | null;
  started_at: number;
  age_ms: number;
  exit_code: number | null;
  exit_reason: string | null;
  log_file: string | null;
}

export async function snapshotStatus(record: GlobalPidRecord): Promise<StatusSnapshot> {
  const alive = isPidAlive(record.pid);
  let state: "active" | "idle" | "stopped";
  let logMtimeMs: number | null = null;
  if (!alive) {
    state = "stopped";
  } else if (record.log_file) {
    logMtimeMs = await stat(record.log_file)
      .then((s) => s.mtimeMs)
      .catch(() => null);
    state = logMtimeMs !== null && Date.now() - logMtimeMs > IDLE_THRESHOLD_MS ? "idle" : "active";
  } else {
    state = "active";
  }
  const activity =
    state !== "stopped" && record.log_file ? await extractActivity(record.log_file) : null;
  const notes = await readNotes();
  const note = notes.get(record.pid) ?? null;
  return {
    pid: record.pid,
    cli: record.cli,
    cwd: record.cwd,
    state,
    activity,
    note,
    log_mtime_ms: logMtimeMs,
    started_at: record.started_at,
    age_ms: Date.now() - record.started_at,
    exit_code: record.exit_code,
    exit_reason: record.exit_reason,
    log_file: record.log_file ?? null,
  };
}

async function cmdStatus(rest: string[]): Promise<number> {
  const y = yargs(rest)
    .usage("Usage: ay status <keyword> [options]")
    .option("watch", {
      alias: "w",
      type: "boolean",
      default: false,
      description: "Stream changes as JSON",
    })
    .option("wait-idle", {
      type: "boolean",
      default: false,
      description: "Block until state == idle. Exit 0 idle, 1 stopped, 2 timeout",
    })
    .option("timeout", {
      type: "string",
      description: "Timeout for --wait-idle (e.g. 30s, 5m). Default: no timeout",
    })
    .option("interval", { type: "number", default: 2, description: "Poll interval in seconds" })
    .option("latest", { type: "boolean", default: false, description: "Use most recent match" })
    .option("cwd", { type: "string", description: "Restrict to agents under this dir" })
    .help(false)
    .version(false)
    .exitProcess(false);

  const argv = await y.parseAsync();
  const opts: CommonOpts = {
    all: true,
    active: false,
    json: false,
    latest: argv.latest,
    cwdScope: typeof argv.cwd === "string" ? path.resolve(argv.cwd) : null,
  };
  const keyword = argv._[0] !== undefined ? String(argv._[0]) : undefined;

  if (!keyword)
    throw new Error("usage: ay status <keyword> [--watch | --wait-idle] [--timeout=Ns]");

  {
    const remote = await resolveRemoteSpec(keyword);
    if (remote) return runRemoteStatus(remote);
  }

  const watch = argv.watch;
  const waitIdle = argv["wait-idle"];
  const intervalFlag = argv.interval;
  const intervalMs = Math.max(500, (Number.isFinite(intervalFlag) ? intervalFlag : 2) * 1000);
  const timeoutMs =
    typeof argv.timeout === "string" && argv.timeout.length > 0
      ? (ms(argv.timeout) ?? Number.NaN)
      : null;
  if (timeoutMs !== null && !Number.isFinite(timeoutMs)) {
    throw new Error(`invalid --timeout value: ${argv.timeout}`);
  }

  const record = await resolveOne(keyword, opts);

  const emit = (snap: StatusSnapshot, ts?: number): void => {
    const out = ts !== undefined ? { ts, ...snap } : snap;
    process.stdout.write(JSON.stringify(out) + "\n");
  };

  if (waitIdle) {
    const startedAt = Date.now();
    for (;;) {
      const snap = await snapshotStatus(record);
      if (snap.state === "idle") {
        emit(snap);
        return 0;
      }
      if (snap.state === "stopped") {
        emit(snap);
        return 1;
      }
      if (timeoutMs !== null && Date.now() - startedAt >= timeoutMs) {
        emit(snap);
        return 2;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  if (!watch) {
    emit(await snapshotStatus(record));
    return 0;
  }

  process.stderr.write(
    `watching pid ${record.pid} every ${intervalMs / 1000}s… (Ctrl-C to stop)\n`,
  );

  let prev: { state: string; activity: string | null; exit_code: number | null } | null = null;

  const tick = async (): Promise<void> => {
    const snap = await snapshotStatus(record);
    if (
      prev === null ||
      snap.state !== prev.state ||
      snap.activity !== prev.activity ||
      snap.exit_code !== prev.exit_code
    ) {
      emit(snap, Date.now());
      prev = { state: snap.state, activity: snap.activity, exit_code: snap.exit_code };
    }
  };

  await tick();

  await new Promise<void>((resolve) => {
    const timer = setInterval(tick, intervalMs);
    process.on("SIGINT", () => {
      clearInterval(timer);
      resolve();
    });
  });

  return 0;
}
