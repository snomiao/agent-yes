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

import { randomBytes } from "crypto";
import { appendFile, mkdir, open, readFile, stat, writeFile } from "fs/promises";
import ms from "ms";
import { homedir } from "os";
import path from "path";
import { type GlobalPidRecord, readGlobalPids, updateGlobalPidStatus } from "./globalPidIndex.ts";
import { buildAgentForest, flattenForest } from "./agentTree.ts";
import { parseTaskCounts, type TaskCounts } from "./todoParse.ts";
import { agentYesHome } from "./agentYesHome.ts";
import {
  type MailParty,
  type MessageRecord,
  partyMatches,
  readMailbox,
  recordMessage,
  recordOutbox,
} from "./messageLog.ts";
import { badgeDef, matchBadges, TYPING_BADGE } from "./badges.ts";
import {
  classifyNeedsInput,
  isWorkingScreen,
  parseMenu,
  type MenuState,
  type NeedsInput,
} from "./needsInput.ts";
import { diffLsStates, type LiveState, type LsAgentState } from "./lsWatch.ts";
import { filterSinceSeq, filterSinceTs, filterUnread, maxSeq, type NotifyEvent } from "./notifyInbox.ts";
import {
  clearWatcher,
  getCursor,
  heartbeatWatcher,
  hostId,
  readInbox,
  setCursor,
} from "./notifyStore.ts";
import {
  buildStoredResult,
  normalizeEnvelope,
  resultPath,
  resultsDir,
  type StoredResult,
} from "./resultEnvelope.ts";
import { loadSharedCliDefaults } from "./configShared.ts";
import { invokedCliName } from "./invokedCli.ts";
import type { AgentCliConfig } from "./index.ts";
import yargs from "yargs";
import { type ResolvedRemote, readRemotes, resolveRemoteSpec } from "./remotes.ts";
import { isWebrtcSpec } from "./webrtcLink.ts";

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

// ---------------------------------------------------------------------------
// read-recency store  (~/.agent-yes/reads.jsonl)
//
// Records that some sender "read" (tailed/cat'd) a target agent at a time, so
// `ay send` can refuse to fire at an agent the sender hasn't actually looked at
// recently. This is the guard against a fuzzy keyword silently resolving to the
// wrong agent (e.g. you tail "babaiban" but a send resolves to "qq-cli").
// ---------------------------------------------------------------------------

const READ_WINDOW_MS = 60_000; // "read recently" = within the last minute

// Max time writeToIpc will keep retrying a backed-up FIFO before erroring. A live
// agent drains its stdin in milliseconds; only a wedged reader hits this.
const IPC_WRITE_TIMEOUT_MS = 10_000;
const READS_KEY_SEP = "\0";

function readsPath(): string {
  const dir = process.env.AGENT_YES_HOME ?? path.join(homedir(), ".agent-yes");
  return path.join(dir, "reads.jsonl");
}

// Each line: {"by":"agent:123"|"human","target":456,"at":<ms>}. Append-only,
// last-per-(by,target) wins; compacted opportunistically so a long `tail -f`
// (which refreshes its marker) can't grow the file without bound.
async function readReads(): Promise<Map<string, number>> {
  let raw: string;
  try {
    raw = await readFile(readsPath(), "utf-8");
  } catch {
    return new Map();
  }
  const map = new Map<string, number>();
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const { by, target, at } = JSON.parse(t);
      if (typeof by === "string" && typeof target === "number" && typeof at === "number")
        map.set(`${by}${READS_KEY_SEP}${target}`, at);
    } catch {
      /* skip corrupt */
    }
  }
  return map;
}

async function recordRead(by: string, target: number): Promise<void> {
  const p = readsPath();
  try {
    await mkdir(path.dirname(p), { recursive: true });
    await appendFile(p, JSON.stringify({ by, target, at: Date.now() }) + "\n");
    // Opportunistic compaction once the append-only log grows past a small cap.
    const raw = await readFile(p, "utf-8").catch(() => "");
    if (raw.split("\n").length > 200) {
      const map = await readReads();
      const lines = [...map.entries()]
        .map(([k, at]) => {
          const i = k.indexOf(READS_KEY_SEP);
          return JSON.stringify({ by: k.slice(0, i), target: Number(k.slice(i + 1)), at });
        })
        .join("\n");
      await writeFile(p, lines ? lines + "\n" : "");
    }
  } catch {
    /* best-effort: the guard degrades to a warning if state can't be written */
  }
}

async function lastReadAt(by: string, target: number): Promise<number | null> {
  const map = await readReads();
  return map.get(`${by}${READS_KEY_SEP}${target}`) ?? null;
}

/** Recent agent→agent read/tail edges (skips "human" readers), for the /rgui
 * relationship-wire view. `by`/`target` are pids. */
export interface ReadEdge {
  by: number;
  target: number;
  at: number;
}
export async function recentReadEdges(windowMs = READ_WINDOW_MS): Promise<ReadEdge[]> {
  const now = Date.now();
  const map = await readReads();
  const out: ReadEdge[] = [];
  for (const [key, at] of map) {
    if (now - at > windowMs) continue;
    const i = key.indexOf(READS_KEY_SEP);
    const by = key.slice(0, i);
    if (!by.startsWith("agent:")) continue; // agent→agent only
    const byPid = Number(by.slice("agent:".length));
    const target = Number(key.slice(i + 1));
    if (byPid && target && byPid !== target) out.push({ by: byPid, target, at });
  }
  return out;
}

// Identify the sender. An agent launched by `ay` inherits AGENT_YES_PID=<wrapper
// pid>; the registered agent record carries that same wrapper_pid, so we map the
// env value back to the agent's own canonical record. Falls back to a direct pid
// match (back-compat), then null when there's no agent context (a human shell).
async function resolveSender(): Promise<GlobalPidRecord | null> {
  const envPid = process.env.AGENT_YES_PID ? Number(process.env.AGENT_YES_PID) : null;
  if (!envPid || Number.isNaN(envPid)) return null;
  const recs = await listRecords(undefined, {
    all: true,
    active: false,
    json: false,
    latest: false,
    cwdScope: null,
  });
  return recs.find((r) => r.wrapper_pid === envPid) ?? recs.find((r) => r.pid === envPid) ?? null;
}

// The (key, agent) pair used to attribute reads and gate sends. Agents get a
// stable per-agent key; a human shell shares the "human" bucket (warn-only).
async function senderContext(): Promise<{ key: string; agent: GlobalPidRecord | null }> {
  const agent = await resolveSender();
  return { key: agent ? `agent:${agent.pid}` : "human", agent };
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

// Subcommands EVERY *-yes binary accepts — inspection/messaging over the shared
// agent registry (`cy ls`, `cy send`, `cy tail`, …).
// MIRRORED in rs/src/cli.rs `SUBCOMMANDS` — the Rust runner delegates these to
// this JS layer; keep the two lists in sync.
const SUBCOMMANDS = new Set([
  "ls",
  "list",
  "ps",
  "status",
  "result",
  "notify",
  "notifyd",
  "read",
  "cat",
  "tail",
  "head",
  "send",
  "msgs",
  "key",
  "select",
  "spawn",
  "attach",
  "stop",
  "exit",
  "restart",
  "note",
  "serve",
  "schedule",
  "remote",
  "expose",
  "reap",
  "help",
]);

// Subcommands reserved for the GENERIC manager (`ay` / `agent-yes`). A cli-bound
// alias like `cy` (= claude-yes = "agent-yes claude") must NOT treat these as
// subcommands — `cy setup …` should run claude with that text, not manage the
// host. Kept separate from SUBCOMMANDS so a runner alias falls straight through.
const MANAGER_SUBCOMMANDS = new Set(["setup"]);

const IDLE_THRESHOLD_MS = 60 * 1000;

// `stuck`: alive + the screen still shows a busy marker (config `working`) yet the
// log has been silent this long — i.e. wedged mid-stream (a silent API stream
// stall), not finished. Deliberately MUCH longer than IDLE_THRESHOLD_MS: a slow
// tool call (tests, install) is also "busy + quiet", so only a prolonged silence
// is reported as stuck. Detection only — never auto-acts. Override via env.
const STUCK_THRESHOLD_MS = (() => {
  const n = Number(process.env.AGENT_YES_STUCK_MS);
  return Number.isFinite(n) && n > 0 ? n : 5 * 60 * 1000;
})();

// `ay send` submit-confirm tuning. A long/multi-line body pasted via bracketed
// paste can take longer than any fixed delay to finish rendering — sending the
// trailing Enter before that settles gets swallowed by the CLI's paste handling
// (it lands mid-paste instead of submitting). So instead of a blind fixed sleep,
// we poll the log for actual quiet, then confirm the Enter landed by watching for
// either a `working` busy marker or a meaningful size bump, retrying if not.
const SEND_SETTLE_QUIET_MS = 150; // no log growth for this long → paste finished rendering
const SEND_SETTLE_MAX_MS = 1500; // cap: don't wait forever on a screen that's busy for other reasons
const SEND_CONFIRM_QUIET_MS = 400; // after Enter, no growth for this long → response has settled
const SEND_CONFIRM_MAX_MS = 1200; // cap per confirm attempt
const SEND_CONFIRM_MIN_GROWTH_BYTES = 8; // filters out pure cursor-blink/frame noise
const SEND_SUBMIT_MAX_RETRIES = 2; // total attempts = 1 + this
// `ay send` typing-backoff: if the user is actively typing at the target's
// terminal, injecting our body mid-line would fuse into their text and submit a
// mangled line. Poll until they pause (activity older than TYPING_WINDOW_MS) or
// we give up, then send anyway with a warning rather than dropping the message.
const SEND_TYPING_POLL_MS = 200;
const SEND_TYPING_MAX_WAIT_MS = 10_000;

/**
 * Whether `name` is a subcommand. `managerCommands` (default true, for the
 * generic `ay`/`agent-yes` entry) additionally admits manager-only commands
 * like `setup`; pass false for a cli-bound alias (cy/claude-yes/…) so those
 * names fall through to running the agent instead.
 */
export function isSubcommand(name: string | undefined, managerCommands = true): boolean {
  if (!name) return false;
  return SUBCOMMANDS.has(name) || (managerCommands && MANAGER_SUBCOMMANDS.has(name));
}

/**
 * Top-level entry. Returns the desired process exit code, or null if argv
 * is not a subcommand invocation.
 */
export async function runSubcommand(argv: string[]): Promise<number | null> {
  const sub = argv[2];
  // Manager-only subcommands (setup) aren't subcommands for a cli-bound alias
  // like `cy` — they fall through to running the agent. Computed once from argv
  // so it holds regardless of caller, and reused to hide manager-only help.
  const managerCommands = !invokedCliName(argv);
  if (!isSubcommand(sub, managerCommands)) return null;

  const rest = argv.slice(3);

  try {
    switch (sub) {
      case "ls":
      case "list":
      case "ps":
        return await cmdLs(rest);
      case "status":
        return await cmdStatus(rest);
      case "result":
        return await cmdResult(rest);
      case "notify":
        return await cmdNotify(rest);
      case "notifyd":
        return await cmdNotifyd(rest);
      case "read":
      case "cat":
        return await cmdRead(rest, { mode: "cat" });
      case "tail":
        return await cmdRead(rest, { mode: "tail" });
      case "head":
        return await cmdRead(rest, { mode: "head" });
      case "send":
        return await cmdSend(rest);
      case "msgs":
        return await cmdMsgs(rest);
      case "key":
        return await cmdKey(rest);
      case "select":
        return await cmdSelect(rest);
      case "spawn":
        return await cmdSpawn(rest);
      case "attach":
        return await cmdAttach(rest);
      case "stop":
        return await cmdStop(rest);
      case "exit":
        return await cmdExit(rest);
      case "restart":
        return await cmdRestart(rest);
      case "note":
        return await cmdNote(rest);
      case "serve": {
        const { cmdServe } = await import("./serve.ts");
        return cmdServe(rest);
      }
      case "setup": {
        const { cmdSetup } = await import("./setup.ts");
        return cmdSetup(rest);
      }
      case "schedule": {
        const { cmdSchedule } = await import("./schedule.ts");
        return cmdSchedule(rest);
      }
      case "remote": {
        const { cmdRemote } = await import("./remotes.ts");
        return cmdRemote(rest);
      }
      case "expose": {
        const { cmdExpose } = await import("./expose.ts");
        return cmdExpose(rest);
      }
      case "reap": {
        const reaper = await import("./reaper.ts");
        await reaper.sweep();
        return 0;
      }
      case "help":
        return cmdHelp(managerCommands);
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
// ay help
// ---------------------------------------------------------------------------

/**
 * The banner shown by `ay help` / `ay -h` when this process is itself running
 * inside an agent (`AGENT_YES_PID` set — see resolveSender). Answers the three
 * things a nested agent actually needs: who am I, who spawned me, and how do I
 * drive sub-agents of my own — so it doesn't have to rediscover the fan-out
 * primitives (spawn / ay ls forest / ay ls --watch) from scratch every session.
 */
async function buildAgentContextSection(self: GlobalPidRecord): Promise<string> {
  const hasParentPid = typeof self.parent_pid === "number" && self.parent_pid > 0;
  const parent = hasParentPid
    ? (
        await listRecords(undefined, {
          all: true,
          active: false,
          json: false,
          latest: false,
          cwdScope: null,
        })
      ).find((r) => r.wrapper_pid === self.parent_pid)
    : undefined;

  const whoAmI = `You are agent pid ${self.pid} (${self.cli}) in ${shortenPath(self.cwd)}.`;
  // Three distinct states: no parent at all (top-level); a parent_pid whose
  // record we can resolve; or a parent_pid we can't resolve (its record aged
  // out / lives on a remote) — that last case is still nested, just unknown,
  // so it must not collapse into the "top-level" line.
  const parentLine = !hasParentPid
    ? `Top-level agent — no parent (started from a human shell or scheduler).`
    : parent
      ? `Spawned by agent pid ${parent.pid} (${parent.cli}) in ${shortenPath(parent.cwd)}.`
      : `Nested under a parent (wrapper pid ${self.parent_pid}) whose record isn't in the local registry.`;

  return (
    `You are running inside an agent:\n` +
    `  ${whoAmI}\n` +
    `  ${parentLine}\n` +
    `\n` +
    `As an agent, you can:\n` +
    `  Spawn a sub-agent:\n` +
    `    ay <cli> -- "<prompt>"                                  auto-links as your child\n` +
    `    ay claude --model sonnet --advisor opus -- "<prompt>"   routine task\n` +
    `    ay claude --model opus --advisor fable -- "<prompt>"    complex task\n` +
    `    (pick --model by task complexity so easy tasks don't cost like hard ones;\n` +
    `     --advisor is a claude-cli flag — only takes effect for claude/cy)\n` +
    `  List agents (your children nest under your own pid in the tree):\n` +
    `    ay ls --cwd ${shortenPath(self.cwd)}\n` +
    `  Watch agent state changes, scoped to your workspace:\n` +
    `    ay ls --watch --cwd ${shortenPath(self.cwd)}\n` +
    `    (NDJSON stream of state changes across every matched agent — one watcher\n` +
    `     for the whole fan-out instead of N \`ay status --watch\`es)\n` +
    `  Read one sub-agent's output:\n` +
    `    ay tail -f <pid>                        follow live output (no single command tails\n` +
    `                                              many agents' content at once yet — loop\n` +
    `                                              \`ay ls --json\` pids into per-pid \`ay tail\`)\n` +
    `\n`
  );
}

export async function cmdHelp(managerCommands = true): Promise<number> {
  // `setup` is manager-only — hide it when invoked through a cli-bound alias
  // (cy/claude-yes/…), where `cy setup` runs the agent instead of managing the host.
  const setupLine = managerCommands
    ? `  ay setup                            guided setup: pick a workspace, share to agent-yes.com\n`
    : ``;
  // Only agents carry AGENT_YES_PID — a human shell never sets it — so this
  // section is skipped entirely (no async work at all) for interactive use.
  const self = process.env.AGENT_YES_PID ? await resolveSender() : null;
  const agentSection = self ? await buildAgentContextSection(self) : "";
  process.stdout.write(
    agentSection +
      `ay - agent-yes CLI\n` +
      `\n` +
      `Management:\n` +
      `  ay ls [keyword]                     list running agents\n` +
      `  ay tail [-f] [-n N] <keyword>       last N lines (96), -f to follow\n` +
      `  ay read <keyword> [page opts]       paginate: --last/--head N, --range A:B,\n` +
      `                                        --before-line L [--limit N]\n` +
      `  ay cat <keyword>                    full log\n` +
      `  ay head <keyword>                   first N lines\n` +
      `  ay send <keyword> <msg>             send a message\n` +
      `  ay msgs [keyword] [--in|--out]      inter-agent message log (sent + received)\n` +
      `  ay key <keyword> <key...>           send raw keystrokes (down/up/enter/esc/…) — drives menus\n` +
      `  ay select <keyword> <N>             pick option N of a needs_input selection menu\n` +
      `  ay attach <keyword>                 interactive attach (detach: Ctrl-\\)\n` +
      `  ay stop <keyword>                   graceful shutdown (/exit for claude/codex)\n` +
      `  ay exit <keyword> [reason]          graceful shutdown, recording who/why (= 'ay send <kw> exit')\n` +
      `  ay restart <keyword> [--fresh]      stop (if live) + relaunch resuming the session; --fresh replays the prompt\n` +
      `  ay status <keyword>                 agent status snapshot\n` +
      `  ay result <keyword> [--wait]        pull an agent's structured result envelope\n` +
      `  ay result set '<json>'              (inside an agent) deposit your result envelope\n` +
      `  ay reap                             kill process groups leaked by dead agents\n` +
      `\n` +
      `Remote:\n` +
      setupLine +
      `  ay schedule <when> <cli> -- <msg>   run an agent on a schedule (HH:MM or cron)\n` +
      `  ay serve [--port N]                 start HTTP API server (prints token)\n` +
      `  ay serve status                     show serve daemon/server status\n` +
      `  ay remote add <alias> http://<token>@<host>:<port>\n` +
      `  ay remote ls / rm <alias>           manage saved remotes\n` +
      `  ay expose <port>                    share localhost:<port> at https://<id>.agent-yes.com (private link)\n` +
      `  ay ls   <token>@<host>:<port>       connect inline (no alias needed)\n` +
      `  ay send <token>@<host>:<port>:<kw> <msg>\n` +
      `\n` +
      `Run an agent:\n` +
      `  ay [claude|codex|gemini|...] [options] -- [prompt]\n` +
      `  ay claude -- "fix the bug in auth.ts"\n` +
      `  ay claude --help                    full agent-runner options\n` +
      `\n` +
      `Labs (examples at https://github.com/snomiao/agent-yes/tree/main/lab):\n` +
      `  local-role-play/   designer + builder on one machine\n` +
      `  http-remote/       ay serve remote access demo\n` +
      `  p2p-pairing/       libp2p P2P  (needs: cargo build --features swarm)\n`,
  );
  return 0;
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
  // 1. A purely-numeric keyword is an IDENTITY selector — exact pid, or an
  // agent_id prefix (ids are 12 random hex, so they can be all-digits). Return
  // here instead of falling through to the cwd/cli/prompt substring rules below:
  // a pid frequently appears inside other agents' cwd/prompt/logs (e.g. a bug
  // report or a shared `/w/#room:<pid>` URL that quotes the pid), and matching
  // those would resolve the wrong agent.
  if (/^\d+$/.test(keyword)) {
    if (record.pid === Number(keyword)) return true;
    return !!(record.agent_id && record.agent_id.toLowerCase().startsWith(kw));
  }
  // 2. cwd contains keyword
  if (record.cwd.toLowerCase().includes(kw)) return true;
  // 3. cli exact (lowercase)
  if (record.cli.toLowerCase() === kw) return true;
  // 4. prompt substring
  if (record.prompt && record.prompt.toLowerCase().includes(kw)) return true;
  // 5. agent_id prefix — reference an agent by its stable id (or a short prefix)
  if (record.agent_id && record.agent_id.toLowerCase().startsWith(kw)) return true;
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

async function pickInteractive(matches: GlobalPidRecord[]): Promise<GlobalPidRecord | null> {
  const list = matches.slice(0, 10);
  let sel = 0;

  const render = () => {
    for (let i = 0; i < list.length; i++) {
      const r = list[i]!;
      const marker = i === sel ? "\x1b[36m>\x1b[0m" : " ";
      process.stderr.write(`${marker} ${r.pid}  ${r.cli}  ${r.cwd}\n`);
    }
  };

  process.stderr.write(`Multiple matches — select with ↑↓ Enter (or type 1-${list.length}):\n`);
  render();

  // Open /dev/tty directly so the picker works even when stdin is piped
  // (e.g. `! ay tail foo` in Claude Code, or `ay tail foo | head`).
  const { openSync } = await import("fs");
  const { ReadStream } = await import("tty");
  const fd = openSync("/dev/tty", "r+");
  const tty = new ReadStream(fd);

  const write = (s: string) => process.stderr.write(s);

  return new Promise((resolve) => {
    tty.setRawMode(true);
    tty.resume();
    tty.setEncoding("utf8");

    const redraw = () => {
      write(`\x1b[${list.length}A\x1b[0J`);
      render();
    };

    const cleanup = () => {
      tty.off("data", onData);
      try {
        tty.setRawMode(false);
      } catch {
        /* ignore */
      }
      tty.destroy();
    };

    // Buffer partial escape sequences — arrow keys (\x1b[A/B) can arrive split
    // across multiple data events on some terminals and PTY wrappers.
    let buf = "";
    const onData = (chunk: string) => {
      buf += chunk;
      while (buf.length > 0) {
        if (buf[0] === "\x1b") {
          if (buf.length < 3) break; // wait for rest of sequence
          const seq = buf.slice(0, 3);
          buf = buf.slice(3);
          if (seq === "\x1b[A") {
            sel = Math.max(0, sel - 1);
            redraw();
          } else if (seq === "\x1b[B") {
            sel = Math.min(list.length - 1, sel + 1);
            redraw();
          }
          // ignore other escape sequences
        } else {
          const key = buf[0]!;
          buf = buf.slice(1);
          if (key === "\x03") {
            cleanup();
            process.stderr.write("\n");
            resolve(null);
            return;
          } else if (key === "\r" || key === "\n") {
            cleanup();
            process.stderr.write("\n");
            resolve(list[sel]!);
            return;
          } else if (key >= "1" && key <= String(list.length)) {
            sel = parseInt(key, 10) - 1;
            redraw();
            cleanup();
            process.stderr.write("\n");
            resolve(list[sel]!);
            return;
          }
        }
      }
    };

    tty.on("data", onData);
  });
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
  // Exact identity beats fuzzy. A numeric pid or a full agent_id names exactly
  // one agent; without this, that agent gets pooled with prompt-substring
  // collisions (e.g. another agent whose prompt/note contains the share URL
  // `…/#room:206812`) and a newest-first tiebreak can hand back the wrong one —
  // so a `/w/#room:<pid>` deep link rendered a sibling's terminal. When the
  // keyword exactly matches one record's pid (or agent_id), that record wins.
  if (/^\d+$/.test(keyword)) {
    const byPid = matches.filter((r) => r.pid === Number(keyword));
    if (byPid.length === 1) return byPid[0]!;
  }
  const kw = keyword.toLowerCase();
  const byAgentId = matches.filter((r) => r.agent_id && r.agent_id.toLowerCase() === kw);
  if (byAgentId.length === 1) return byAgentId[0]!;
  if (matches.length === 1) return matches[0]!;
  if (opts.latest) return matches[0]!; // already sorted newest-first
  if (process.stderr.isTTY && process.platform !== "win32") {
    try {
      const chosen = await pickInteractive(matches);
      if (chosen) return chosen;
      throw new Error("no agent selected");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        // /dev/tty not available (no controlling terminal), fall through
      } else {
        throw e;
      }
    }
  }
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
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${remote.url}${pathname}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${remote.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
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
  _plain = false,
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
    // SIGINT/SIGTERM/SIGHUP and a closed pipe all abort the stream, so
    // `timeout … ay tail -f` and `kill` terminate promptly (was SIGINT-only,
    // which let `timeout` run the full --reconnect-timeout window). The server
    // already sends rendered, newline-delimited text, so the wire is plain.
    const disposeSignals = installStreamSignals(() => ac.abort());
    ac.signal.addEventListener("abort", disposeSignals, { once: true });
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
  // Attribute the send so the remote can record its recipient's inbox with a real
  // sender (not an anonymous cross-wire write). Human shell → no `from`.
  const sender = await senderContext();
  const from = sender.agent
    ? {
        pid: sender.agent.pid,
        cli: sender.agent.cli,
        cwd: sender.agent.cwd,
        agent_id: sender.agent.agent_id,
      }
    : null;
  const res = await remotePost(remote, "/api/send", { keyword, msg, code, from });
  if (!res.ok) {
    process.stderr.write(`remote error ${res.status}: ${await res.text()}\n`);
    return 1;
  }
  const data = (await res.json()) as {
    pid: number;
    cli?: string;
    cwd?: string;
    agentId?: string;
  };
  process.stdout.write(`sent to remote pid ${data.pid} (${remote.url}  ${keyword})\n`);
  // Record the sender's half of the exchange locally (the recipient's inbox is
  // recorded on the remote host by its /api/send handler). Only real bodies.
  if (msg && msg !== "-") {
    await recordOutbox({
      at: Date.now(),
      from,
      to: {
        pid: data.pid,
        cli: data.cli ?? keyword,
        cwd: data.cwd ?? "",
        agent_id: data.agentId,
      },
      body: msg,
      code: code.toLowerCase() === "enter" ? undefined : code.toLowerCase(),
      confirmed: true,
      wrapped: false,
      remote: remote.url,
    });
  }
  return 0;
}

/**
 * Spawn an agent on a remote host by POSTing its existing `/api/spawn`. The
 * remote applies ITS OWN spawn hook + provision allowlist server-side (the hook
 * never crosses the wire). `hint` is the user-typed target (alias or
 * token@host:port) so the printed follow-ups are copy-pasteable.
 *
 * NO retry: a POST that already spawned must never be re-sent (double-spawn). A
 * generous timeout still bounds a half-open/stalled connection — on timeout the
 * result is UNKNOWN, so we say so and point at `ay ls` rather than retrying.
 */
async function runRemoteSpawn(
  remote: ResolvedRemote,
  hint: string,
  spec: { cli: string; cwd?: string; from?: string; prompt?: string },
): Promise<number> {
  // A hooked `/api/spawn` (#126) can legitimately block up to the remote's
  // handshake window, so the timeout is generous; it only guards a dead/half-open
  // connection that would otherwise hang the CLI forever.
  const SPAWN_TIMEOUT_MS = Number(process.env.AGENT_YES_REMOTE_SPAWN_TIMEOUT_MS) || 120_000;
  let res: Response;
  try {
    res = await remotePost(
      remote,
      "/api/spawn",
      {
        cli: spec.cli,
        cwd: spec.cwd || undefined,
        from: spec.from || undefined,
        prompt: spec.prompt || undefined,
      },
      AbortSignal.timeout(SPAWN_TIMEOUT_MS),
    );
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      // The request may or may not have spawned — do NOT retry. Let the operator check.
      process.stderr.write(
        `remote spawn: no response from ${remote.url} within ${Math.round(SPAWN_TIMEOUT_MS / 1000)}s — ` +
          `result UNKNOWN (not retried).\n  ay ls ${hint}    # check whether it started\n`,
      );
      return 2;
    }
    process.stderr.write(`remote spawn failed: ${(e as Error).message}\n`);
    return 1;
  }
  if (!res.ok) {
    process.stderr.write(`remote spawn failed ${res.status}: ${await res.text()}\n`);
    return 1;
  }
  const r = (await res.json()) as {
    pid: number;
    cli: string;
    cwd: string;
    agentId?: string;
    hook?: boolean;
    provisioned?: { action: string };
  };
  process.stdout.write(
    `spawned ${r.cli} on ${remote.url} in ${r.cwd}` +
      `${r.hook ? " (via spawn hook)" : ""}` +
      `${r.provisioned ? ` (${r.provisioned.action})` : ""}\n`,
  );
  // `/api/spawn` returns a correlation `agentId` that the agent adopts as its
  // agent_id — so we address the EXACT agent by it (no pid guessing, no race). A
  // webrtc:// / share-link target isn't `:keyword`-addressable, so the keyword
  // hint is only for an alias / token@host:port. Older remotes omit agentId →
  // fall back to pointing at `ay ls`.
  if (r.agentId && !hint.includes("://")) {
    process.stderr.write(
      `\n  ay tail ${hint}:${r.agentId}            # watch its output\n` +
        `  ay status ${hint}:${r.agentId} --wait   # block until it needs you\n`,
    );
  } else {
    process.stderr.write(`\n  ay ls ${hint}    # the new ${r.cli} agent appears here\n`);
  }
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
  // WebRTC remotes have no http port — bridge them, then fetch the loopback URL.
  let bridge: { baseUrl: string; token: string; close: () => void } | null = null;
  try {
    let base = url;
    let bearer = token;
    if (isWebrtcSpec(url)) {
      const { startWebrtcBridge } = await import("./webrtcRemote.ts");
      bridge = await startWebrtcBridge(url);
      base = bridge.baseUrl;
      bearer = bridge.token;
    }
    const res = await fetch(`${base}/api/ls?${params}`, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    return (await res.json()) as any[];
  } catch {
    return [];
  } finally {
    bridge?.close();
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

  // Group by host in a stable order (local first, then each remote alias in
  // config order), so the aggregated table reads top-down per machine.
  const byHost: { host: string; records: any[] }[] = [];
  // Shared per-invocation caches so local agents in the same repo spawn
  // `git status` once (see gitStatusOnce).
  const gitRootCache = new Map<string, string>();
  const gitInfoCache = new Map<string, GitInfo | null>();
  if (localResult.status === "fulfilled") {
    // Local records come from listRecords() RAW — unlike the remote /api/ls
    // payload they carry no derived live-state, last_active_at, task counts,
    // status badges, or git tag, so left alone they'd render a flat "active"
    // with no age/badge/git. Enrich them to the same shape the API returns, so
    // local agents get the same idle/needs_input/stuck status, staleness age,
    // task badges, status-flag chips, and git dirty/sync tag.
    const enriched = await Promise.all(
      localResult.value.records.map(async (r) => {
        const { state, question } = await deriveLiveState(r);
        const alive = state !== "stopped";
        const [tasks, badges, git, typing] = alive
          ? await Promise.all([
              r.log_file ? extractTaskCounts(r.log_file) : Promise.resolve(null),
              r.log_file ? extractBadges(r.log_file) : Promise.resolve([]),
              gitStatusOnce(r.cwd, gitRootCache, gitInfoCache),
              isUserTyping(r.pid),
            ])
          : [null, [], null, false];
        return {
          ...r,
          status: state,
          question,
          last_active_at: await deriveLastActiveAt(r),
          tasks,
          badges: typing ? [...(badges as string[]), TYPING_BADGE.id] : badges,
          git,
        };
      }),
    );
    byHost.push({ host: "local", records: enriched });
  }
  for (const res of remoteResults) {
    if (res.status === "fulfilled") byHost.push({ host: res.value.host, records: res.value.records });
  }

  // Flatten each host's records into its agent>subagent forest (parent_pid links),
  // carrying the box-drawing tree prefix — the same nesting the console's left
  // panel shows. Degrades to a flat newest-first list when there are no links.
  type HostedRow = { host: string; rec: any; prefix: string };
  const rows: HostedRow[] = [];
  for (const { host, records } of byHost) {
    for (const { record, prefix } of flattenForest(buildAgentForest(records))) {
      rows.push({ host, rec: record, prefix });
    }
  }

  if (rows.length === 0) {
    process.stderr.write("no running agents\n");
    return 0;
  }

  const termWidth = (process.stdout as any).columns ?? 120;
  const now = Date.now();
  const ageOf = (rec: any) => humanizeAge(now - (rec.last_active_at ?? rec.started_at));
  const badgeOf = (rec: any) => (rec.tasks ? `${rec.tasks.done}/${rec.tasks.total} ` : "");
  const hostW = Math.max(4, ...rows.map((r) => r.host.length));
  const pidW = Math.max(3, ...rows.map((r) => String(r.rec.pid).length));
  const cliW = Math.max(3, ...rows.map((r) => String(r.rec.cli).length));
  const statusW = Math.max(6, ...rows.map((r) => String(r.rec.status).length));
  const ageW = Math.max(3, ...rows.map((r) => ageOf(r.rec).length));
  const cwdW = Math.max(3, ...rows.map((r) => shortenPath(String(r.rec.cwd)).length));
  const promptBudget = Math.max(
    20,
    termWidth - hostW - pidW - cliW - statusW - ageW - cwdW - 6 * 2 - 1,
  );

  process.stdout.write(
    [
      "HOST".padEnd(hostW),
      "PID".padEnd(pidW),
      "CLI".padEnd(cliW),
      "STATUS".padEnd(statusW),
      "AGE".padEnd(ageW),
      "CWD".padEnd(cwdW),
      "PROMPT",
    ].join("  ") + "\n",
  );
  for (const { host, rec, prefix } of rows) {
    // The tree prefix + task badge + flag chips + git tag live inside the PROMPT
    // column, so they eat into this row's text budget — same as the single-host
    // table. Both local (enriched above) and remote (/api/ls) records carry
    // `tasks`, `badges`, and `git` in the same shape.
    const flagStr = badgeLabels(rec.badges);
    const branchStr = branchLabel(rec.git);
    const gitStr = gitLabel(rec.git);
    const deco =
      badgeOf(rec) +
      (flagStr ? flagStr + " " : "") +
      (branchStr ? branchStr + " " : "") +
      (gitStr ? gitStr + " " : "");
    const budget = Math.max(8, promptBudget - prefix.length - deco.length);
    const label = prefix + deco + (rec.prompt ? truncate(`→ ${rec.prompt}`, budget) : "");
    process.stdout.write(
      [
        host.padEnd(hostW),
        String(rec.pid).padEnd(pidW),
        String(rec.cli).padEnd(cliW),
        String(rec.status).padEnd(statusW),
        ageOf(rec).padEnd(ageW),
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

/**
 * Cheap live status from liveness + log quiescence only (no log-content read):
 * `exited` when the pid is gone or the record is exited, else `idle` when the log
 * has been quiet longer than IDLE_THRESHOLD_MS, else `active`. The stored `status`
 * field can go stale (the wrapper's idle mirror lags), so anything surfacing live
 * status should derive it here. Safe to call per-agent on a hot path — one stat(),
 * no 32KB tail read — which is why the serve's 1s console tick uses THIS rather
 * than the richer deriveLiveState below.
 */
export async function deriveLiveStatus(r: GlobalPidRecord): Promise<"active" | "idle" | "exited"> {
  if (r.status === "exited" || !isPidAlive(r.pid)) return "exited";
  if (!r.log_file) return "active";
  const mtime = await stat(r.log_file)
    .then((s) => s.mtimeMs)
    .catch(() => null);
  return mtime !== null && Date.now() - mtime > IDLE_THRESHOLD_MS ? "idle" : "active";
}

/**
 * The live display state of one agent: stopped (exited) / idle (alive+quiet) /
 * active (alive+recent output) / needs_input (alive but parked on an unanswered
 * menu). Shared by the `ay ls` human table AND its `--json` output so both report
 * needs_input identically — an orchestrator parsing `ay ls --json` is the primary
 * consumer. Builds on the cheap deriveLiveStatus, then adds the menu (needs_input)
 * override, which DOES read the log tail.
 */
export async function deriveLiveState(
  r: GlobalPidRecord,
): Promise<{ state: LiveState; question: string | null }> {
  const base = await deriveLiveStatus(r);
  if (base === "exited") return { state: "stopped", question: null };
  // The Rust supervisor flagged this agent unresponsive (no PTY output after a
  // poke / a frozen "working" spinner) — an authoritative wedge signal, so it
  // wins over the log-tail heuristics (needs_input / stuck) below.
  if (r.unresponsive) return { state: "stuck", question: null };
  // A blocked menu overrides active/idle (alive + quiet, but waiting for an answer).
  if (r.log_file) {
    const ni = await extractNeedsInput(r.log_file, r.cli);
    if (ni) return { state: "needs_input", question: ni.question };
    // Quiet long enough to read "idle", but the screen still shows a busy marker
    // => wedged mid-stream, not finished. Surface as `stuck`, not `idle`.
    if (base === "idle" && (await isAgentStuck(r))) return { state: "stuck", question: null };
  }
  return { state: base, question: null };
}

/**
 * When the agent last wrote stdout — the log file's mtime, falling back to
 * started_at when there's no log yet (freshly spawned). Mirrors serve.ts's
 * `last_active_at`, so the `ay ls` AGE column measures STALENESS (time since the
 * agent last produced output) rather than lifetime — matching the console's
 * left-panel age. A long-lived but quiet agent then reads as stale, not "new".
 */
async function deriveLastActiveAt(r: GlobalPidRecord): Promise<number> {
  if (!r.log_file) return r.started_at;
  return stat(r.log_file)
    .then((s) => s.mtimeMs)
    .catch(() => r.started_at);
}

// Git dirty/sync counts for one repo, in the shape serve.ts's /api/ls returns
// (so `ay ls` can format LOCAL agents' git the same way it formats remote ones,
// whose `git` field already arrives in this shape).
interface GitInfo {
  branch: string | null;
  dirty: boolean;
  changed: number; // real file changes (excludes submodule pin-bumps & internal dirt)
  pins: number; // submodule gitlinks pointing at new commit(s) — pin-bump/drift
  subDirty: number; // submodule has internal changes but its recorded pin is unchanged
  ahead: number;
  behind: number;
}

/**
 * Format a GitInfo into the console's compact tag: "±3" changed files, "⑂2"
 * submodule pin-bumps, "⊙1" submodule internal dirt, "↑1" ahead, "↓2" behind.
 * Mirrors gitLabel() in lab/ui/console-logic.js so `ay ls` and the web panel's
 * left rail read identically. "" when clean / in sync / not a repo.
 */
function gitLabel(g: GitInfo | null | undefined): string {
  if (!g) return "";
  const parts: string[] = [];
  if (g.changed > 0) parts.push("±" + g.changed);
  if (g.pins > 0) parts.push("⑂" + g.pins);
  if (g.subDirty > 0) parts.push("⊙" + g.subDirty);
  if (g.ahead > 0) parts.push("↑" + g.ahead);
  if (g.behind > 0) parts.push("↓" + g.behind);
  return parts.join(" ");
}

/**
 * The checked-out branch as "⎇<name>" (⎇ = the branch/alt-key glyph). Shows the
 * ACTUAL git branch, which can differ from the worktree folder in the cwd (a
 * feature branch checked out in .../tree/main, a detached HEAD, etc.). "" when
 * detached / not a repo. Kept separate from gitLabel so gitLabel stays a mirror
 * of the web console's tag.
 */
function branchLabel(g: GitInfo | null | undefined): string {
  return g?.branch ? "⎇" + g.branch : "";
}

/**
 * Short status-flag chips ("goal", "retry", "limit") for a list of badge ids —
 * the same flags the console shows, resolved to their labels via badges.ts.
 * "" when none. (Remote records carry `badges` from /api/ls; local ones are
 * matched here via extractBadges.)
 */
function badgeLabels(ids: string[] | null | undefined): string {
  if (!ids || ids.length === 0) return "";
  return ids.map((id) => badgeDef(id)?.label ?? id).join(" ");
}

// porcelain=v2 --branch parser — mirrors parseGitStatus in serve.ts (that copy
// lives inside the serve closure and is watcher-driven, so it can't be shared
// without a refactor; keep the two in sync). Submodule pin-bumps/internal dirt
// are split out of `changed` so a submodule-heavy repo doesn't read as dirty.
function parseGitStatus(out: string): GitInfo {
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  let changed = 0;
  let pins = 0;
  let subDirty = 0;
  for (const line of out.split("\n")) {
    if (line.length === 0) continue;
    if (line[0] === "#") {
      const head = /^# branch\.head (.+)$/.exec(line);
      if (head) {
        branch = head[1] === "(detached)" ? null : head[1]!;
        continue;
      }
      const ab = /^# branch\.ab \+(\d+) -(\d+)/.exec(line);
      if (ab) {
        ahead = Number(ab[1]);
        behind = Number(ab[2]);
      }
      continue;
    }
    const type = line[0];
    if (type === "?" || type === "u") {
      changed++;
    } else if (type === "1" || type === "2") {
      const sub = line.split(" ")[2] ?? "N...";
      if (sub[0] === "S") {
        if (sub[1] === "C") pins++;
        else subDirty++;
      } else {
        changed++;
      }
    }
  }
  return { branch, dirty: changed > 0, changed, pins, subDirty, ahead, behind };
}

async function runGitCli(args: string[], cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
      signal: AbortSignal.timeout(2000),
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return proc.exitCode === 0 ? out : null;
  } catch {
    return null; // git missing, not a repo, or timed out
  }
}

/**
 * One-shot git status for the `ay ls` CLI. serve.ts keeps a per-repo watcher so
 * its request path never spawns git; a one-shot CLI has no watcher, so it spawns
 * `git status` directly — but deduped per repo root via the two caches, so N
 * agents sharing a repo (or its submodules/subdirs) cost ONE `git status`.
 */
async function gitStatusOnce(
  cwd: string | null | undefined,
  rootCache: Map<string, string>,
  infoCache: Map<string, GitInfo | null>,
): Promise<GitInfo | null> {
  if (!cwd) return null;
  let root = rootCache.get(cwd);
  if (root === undefined) {
    root = ((await runGitCli(["rev-parse", "--show-toplevel"], cwd)) ?? "").trim();
    rootCache.set(cwd, root);
  }
  if (!root) return null; // not a git repo
  if (infoCache.has(root)) return infoCache.get(root)!;
  const out = await runGitCli(["status", "--porcelain=v2", "--branch"], root);
  const info = out != null ? parseGitStatus(out) : null;
  infoCache.set(root, info);
  return info;
}

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
    .option("watch", {
      alias: "w",
      type: "boolean",
      default: false,
      description:
        "Stream agent state transitions (needs_input | idle | active | stuck | stopped) as NDJSON " +
        "across all matched agents — one event stream for a whole fan-out, instead of N " +
        "per-pid `ay status --watch`es. Runs until Ctrl-C.",
    })
    .option("interval", {
      type: "number",
      default: 2,
      description: "Poll interval in seconds (--watch)",
    })
    .option("latest", {
      type: "boolean",
      default: false,
      description: "Show only the most recent agent",
    })
    .option("cwd", { type: "string", description: "Restrict to agents whose cwd starts with dir" })
    .option("all-remotes", {
      type: "boolean",
      default: false,
      description:
        "Include agents from all configured remotes (now the default — kept for explicitness)",
    })
    .option("local", {
      type: "boolean",
      default: false,
      description:
        "Only this machine's agents — skip configured remotes (the pre-default behaviour)",
    })
    .option("help", { alias: "h", type: "boolean", default: false, description: "Show this help" })
    .example("ay ls", "list local + all configured remotes")
    .example("ay ls --local", "only this machine's agents")
    .example("ay ls --all", "include exited agents")
    .example("ay ls --json", "machine-readable output")
    .example("ay ls --watch", "stream state transitions for a whole fan-out as NDJSON")
    .example("ay ls symval", "filter by cwd/prompt keyword")
    .help(false)
    .version(false)
    .exitProcess(false);

  const argv = await y.parseAsync();

  if (argv.help || argv.h) {
    process.stdout.write((await y.getHelp()) + "\n");
    return 0;
  }

  const keyword = argv._[0] !== undefined ? String(argv._[0]) : undefined;
  // A keyword naming a specific remote (alias or token@host:port) → just that
  // remote, regardless of the local/all-remotes default below.
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

  // `ay ls --watch`: a single NDJSON stream of state transitions across every
  // matched agent. The fan-out primitive — one watcher for a whole batch instead
  // of N `ay status <pid> --watch`es. Always JSON (a stream of events, not a
  // table); honours the same keyword/--cwd filter so a parent can scope it to
  // its own fan-out. Output is the same `deriveLiveState` shape `ay ls --json`
  // already reports, so consumers parse one schema.
  if (argv.watch) {
    const intervalMs = Math.max(500, (Number.isFinite(argv.interval) ? argv.interval : 2) * 1000);
    process.stderr.write(`watching agents every ${intervalMs / 1000}s… (Ctrl-C to stop)\n`);
    let prev = new Map<number, LsAgentState>();
    const tick = async (): Promise<void> => {
      const recs = await listRecords(keyword, opts);
      const cur: LsAgentState[] = await Promise.all(
        recs.map(async (r) => {
          const { state, question } = await deriveLiveState(r);
          return { pid: r.pid, cli: r.cli, cwd: r.cwd, state, question };
        }),
      );
      const { events, next } = diffLsStates(prev, cur, Date.now());
      for (const e of events) process.stdout.write(JSON.stringify(e) + "\n");
      prev = next;
    };
    await tick();
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        void tick();
      }, intervalMs);
      process.on("SIGINT", () => {
        clearInterval(timer);
        resolve();
      });
    });
    return 0;
  }

  // The human table now spans local + every configured remote by DEFAULT (one
  // fleet view across machines). `--local` opts back to this machine only, and
  // a single-machine box (no remotes configured) keeps the richer local-only
  // table automatically. The programmatic paths above (--watch) and the --json
  // path below stay LOCAL-only on purpose: orchestrators parse them and expect
  // this box's pids, and the aggregated view is a flat human table without the
  // forest/notes/badges those consumers don't need.
  if (!argv.local && !opts.json && !argv.latest) {
    const remotes = await readRemotes();
    if (argv["all-remotes"] || remotes.size > 0) {
      return runAllRemotesLs({ all: argv.all, active: argv.active, keyword });
    }
  }

  const records = await listRecords(keyword, opts);

  if (opts.json) {
    // Enrich each record with the live computed `state` (incl. needs_input) and
    // `question`, alongside the raw fields — so `ay ls --json` (the machine path
    // an orchestrator parses) reports the same status the human table does. The
    // original `status` field is preserved for backward compatibility.
    const enriched = await Promise.all(
      records.map(async (r) => ({ ...r, ...(await deriveLiveState(r)) })),
    );
    process.stdout.write(JSON.stringify(enriched, null, 2) + "\n");
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

  // AGE is time since last stdout (staleness), not lifetime — same signal the
  // console's left panel shows. Precomputed here (one stat() per agent) so the
  // width pass and the row pass agree without stat()ing twice.
  const now = Date.now();
  const lastActive = new Map<number, number>(
    await Promise.all(records.map(async (r) => [r.pid, await deriveLastActiveAt(r)] as const)),
  );
  const ageOf = (r: GlobalPidRecord) => humanizeAge(now - (lastActive.get(r.pid) ?? r.started_at));

  const rawCwds = records.map((r) => shortenPath(r.cwd));
  const widths = {
    pid: Math.max(3, ...records.map((r) => String(r.pid).length)),
    cli: Math.max(3, ...records.map((r) => r.cli.length)),
    status: Math.max(6, ...records.map((r) => r.status.length)),
    age: Math.max(3, ...records.map((r) => ageOf(r).length)),
    cwd: Math.max(3, ...rawCwds.map((c) => c.length)),
  };
  const fixedWidth = widths.pid + widths.cli + widths.status + widths.age + widths.cwd + 5 * 2; // 5 separators of "  "
  const promptBudget = Math.max(20, termWidth - fixedWidth - 1);

  // Reorder into the agent>subagent forest: a nested `ay` launched from inside
  // another agent renders indented under its parent (parent_pid === wrapper_pid),
  // newest-first preserved within each sibling group. Degrades to the flat
  // newest-first list when no parent links are present (e.g. all top-level).
  const forestRows = flattenForest(buildAgentForest(records));

  const notes = await readNotes();
  // Shared per-invocation caches so agents in the same repo spawn `git status`
  // once (see gitStatusOnce). One `ay ls` call, not one per agent.
  const gitRootCache = new Map<string, string>();
  const gitInfoCache = new Map<string, GitInfo | null>();
  const rows = await Promise.all(
    forestRows.map(async ({ record: r, prefix }) => {
      // Same live-state derivation as the --json path: stopped/idle/active, with
      // needs_input when the agent is parked on an unanswered menu.
      const displayStatus: string = (await deriveLiveState(r)).state;
      const alive = displayStatus !== "stopped";
      const note = notes.get(r.pid);
      // Task progress ("2/5"), status-flag chips ("goal"/"retry"/"limit"), and the
      // git dirty/sync tag ("±3 ⑂2 ↓1") — the same three decorations the console's
      // left rail shows. Skipped for stopped agents (screen no longer live).
      const [tasks, flags, git, typing] = alive
        ? await Promise.all([
            r.log_file ? extractTaskCounts(r.log_file) : Promise.resolve(null),
            r.log_file ? extractBadges(r.log_file) : Promise.resolve([]),
            gitStatusOnce(r.cwd, gitRootCache, gitInfoCache),
            isUserTyping(r.pid),
          ])
        : [null, [], null, false];
      const taskBadge = tasks ? `${tasks.done}/${tasks.total} ` : "";
      const flagStr = badgeLabels(typing ? [...(flags as string[]), TYPING_BADGE.id] : flags);
      const branchStr = branchLabel(git);
      const gitStr = gitLabel(git);
      // task badge, flag chips, then the git group (⎇branch + dirty/sync tag) —
      // compact, single-spaced.
      const deco =
        taskBadge +
        (flagStr ? flagStr + " " : "") +
        (branchStr ? branchStr + " " : "") +
        (gitStr ? gitStr + " " : "");
      // The tree branch prefix + these decorations sit inside the NOTE/PROMPT
      // column, so they eat into this row's text budget.
      const budget = Math.max(8, promptBudget - prefix.length - deco.length);
      let label: string;
      let hasNote = false;
      if (note) {
        label = truncate(note, budget);
        hasNote = true;
      } else if (r.log_file && alive) {
        const activity = await extractActivity(r.log_file);
        label = truncate(activity ?? (r.prompt ? `→ ${r.prompt}` : ""), budget);
      } else {
        label = truncate(r.prompt ? `→ ${r.prompt}` : "", budget);
      }
      // Note marker + decorations sit after the branch prefix so the tree aligns.
      label = prefix + (hasNote ? "* " : "") + deco + label;
      return {
        pid: String(r.pid),
        cli: r.cli,
        status: displayStatus,
        age: ageOf(r),
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
        r.label,
      ].join("  ") + "\n",
    );
  }

  if (!opts.json && rows.length > 0) {
    const alive = rows.find((r) => r._alive);
    const stopped = rows.find((r) => !r._alive);
    const hints: string[] = ["\n"];
    if (alive) {
      hints.push(`  ay status ${alive.pid}                # JSON status snapshot (+ question)\n`);
      hints.push(`  ay status ${alive.pid} --watch        # stream state changes as JSON\n`);
      hints.push(
        `  ay status ${alive.pid} --wait         # block until it needs you (needs_input|idle|stopped)\n`,
      );
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
    .usage(
      "Usage: ay read/cat/tail/head <keyword> [options]\n\n" +
        "Pagination (static read; render the log once, window the rendered lines):\n" +
        "  --last N | --head N         last / first N lines\n" +
        "  --range A:B                 lines A..B (1-indexed, inclusive)\n" +
        "  --before-line L [--limit N] the page of N lines ending just above line L",
    )
    .option("follow", {
      alias: "f",
      type: "boolean",
      default: false,
      description: "Follow log output (Ctrl-C to stop)",
    })
    .option("n", { type: "number", description: "Number of lines (default: 96 for tail/head)" })
    .option("last", { type: "number", description: "Show the last N rendered lines" })
    .option("head", { type: "number", description: "Show the first N rendered lines" })
    .option("range", {
      type: "string",
      description: "Show rendered lines A:B (1-indexed, inclusive)",
    })
    .option("before-line", {
      type: "number",
      description: "Paginate: show the page of lines ending just above line L",
    })
    .option("limit", { type: "number", description: "Page size for --before-line (default 96)" })
    .option("plain", {
      type: "boolean",
      default: false,
      description:
        "Line-buffered plain text for pipes/scripts (no ANSI redraws or spinner). " +
        "Auto-enabled when stdout is not a TTY.",
    })
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
  // A closed downstream pipe (e.g. `… | head -3`) makes stdout writes fail with
  // EPIPE. Treat it as a clean exit — the reader is gone, our job is done.
  ensureEpipeExit();
  // Pipes/scripts get line-buffered plain text by default; an explicit --plain
  // forces it even on a TTY. See followPlainLocal / runRemoteRead.
  const plain = Boolean(argv.plain) || !process.stdout.isTTY;
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
    if (remote) return runRemoteRead(remote, mode, argv.follow, n2, reconnectTimeoutMs, plain);
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

  // Mark that we've looked at this agent. `ay send` uses this to refuse firing
  // at an agent the sender hasn't read recently (the wrong-target guard).
  const reader = await senderContext();
  await recordRead(reader.key, record.pid);

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
  const size = await readPtysize(record.pid);
  const notes = await readNotes();
  const noteLabel = notes.get(record.pid);
  const header = noteLabel
    ? `[pid ${record.pid}  ${shortenPath(record.cwd)}  * ${noteLabel}]`
    : `[pid ${record.pid}  ${shortenPath(record.cwd)}]`;

  if (follow) {
    // Follow mode ignores pagination: print the initial context, then stream deltas.
    const rendered = await renderRawLog(buf, { mode, n, cols: size?.cols, rows: size?.rows });
    process.stderr.write(header + "\n");
    process.stdout.write(rendered);
    if (!rendered.endsWith("\n")) process.stdout.write("\n");
    // Keep the read marker fresh while actively following, so a long-running
    // `ay tail -f` doesn't "expire" past the send window mid-watch.
    const refresh = setInterval(() => void recordRead(reader.key, record.pid), 30_000);
    refresh.unref?.();
    return plain ? followPlainLocal(logPath, buf) : followRawLocal(logPath, buf);
  }

  // Static read: render the full log once, then window into the rendered lines
  // so line numbers (and the pagination cursor in the footer) are exact.
  const allLines = await renderRawLogLines(buf, { cols: size?.cols, rows: size?.rows });
  const total = allLines.length;
  const win = resolveReadWindow({
    total,
    mode,
    n: argv.n,
    last: argv.last,
    head: argv.head,
    range: argv.range,
    beforeLine: argv["before-line"] as number | undefined,
    limit: argv.limit,
  });
  const rendered = allLines.slice(win.start, win.end).join("\n");
  process.stderr.write(header + "\n");
  process.stdout.write(rendered);
  if (!rendered.endsWith("\n")) process.stdout.write("\n");

  // Footer. When older lines exist above the view, print the exact "page up"
  // cursor: `--before-line <first-visible>` round-trips to the page just above.
  const firstVisible = win.start + 1; // 1-indexed
  const shown = win.end - win.start;
  const hints = [`\n`, `  ay ls                                 # list all agents\n`];
  if (win.start > 0) {
    hints.push(
      `  ay read ${record.pid} --before-line ${firstVisible} --limit ${shown || READ_PAGE_DEFAULT}   # older lines (page up)\n`,
    );
  }
  hints.push(
    `  ay read ${record.pid} --range A:B            # lines A..B of ${total}\n`,
    `  ay tail -f ${record.pid}              # follow live output\n`,
    `  ay send ${record.pid} "next: ..."      # send a prompt\n`,
  );
  process.stderr.write(hints.join(""));
  return 0;
}

/**
 * Exit cleanly when stdout's downstream closes (EPIPE). Node ignores SIGPIPE and
 * surfaces a broken pipe as a stream 'error'; with no listener it throws, and in
 * follow mode the watch loop would otherwise hang. Idempotent — one listener for
 * the life of the process, tagged on stdout so repeated calls (and module
 * reloads in tests) don't pile up listeners.
 */
function ensureEpipeExit(): void {
  const TAG = "__ayEpipeExit";
  if ((process.stdout as unknown as Record<string, boolean>)[TAG]) return;
  (process.stdout as unknown as Record<string, boolean>)[TAG] = true;
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (e?.code === "EPIPE") process.exit(0);
  });
}

/**
 * Install signal handlers for a streaming follower so it terminates promptly
 * under automation, not just on an interactive Ctrl-C. SIGINT/SIGTERM/SIGHUP all
 * run `stop` (so `timeout … ay tail -f` and `kill` both work); a closed stdout
 * (EPIPE) exits cleanly via ensureEpipeExit. Returns a disposer that removes the
 * signal listeners.
 */
function installStreamSignals(stop: () => void): () => void {
  ensureEpipeExit();
  const onSig = () => stop();
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);
  process.on("SIGHUP", onSig);
  return () => {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
    process.off("SIGHUP", onSig);
  };
}

/**
 * Coalescing file watcher: re-reads `logPath` on every change, hands each newly
 * appended byte range to `onChunk`, and never overlaps reads (a change that
 * arrives mid-read is serviced once the current read finishes). `startOffset`
 * is where the already-emitted prefix ends. Resolves when `stop` is signalled.
 */
async function watchAppend(
  logPath: string,
  startOffset: number,
  onChunk: (chunk: Uint8Array) => Promise<void> | void,
  onStop: () => void,
): Promise<void> {
  const { watch } = await import("fs");
  let offset = startOffset;
  let reading = false;
  let pending = false;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        watcher.close();
      } catch {}
      dispose();
      onStop();
      resolve();
    };
    const dispose = installStreamSignals(finish);
    const pump = async () => {
      if (reading) {
        pending = true;
        return;
      }
      reading = true;
      do {
        pending = false;
        let full: Uint8Array;
        try {
          full = await readFile(logPath);
        } catch {
          break;
        }
        if (full.length > offset) {
          const chunk = full.slice(offset);
          offset = full.length;
          await onChunk(chunk);
        }
      } while (pending && !done);
      reading = false;
    };
    const watcher = watch(logPath, () => void pump());
    // The file may have grown between our initial read and the watch starting.
    void pump();
  });
}

/**
 * Default (interactive) follow: append each new byte range with ANSI/control
 * sequences stripped. Mirrors the historical behaviour, plus prompt signal /
 * pipe-close handling.
 */
async function followRawLocal(logPath: string, buf: Uint8Array): Promise<number> {
  process.stderr.write(`following... (Ctrl-C to stop)\n`);
  // oxlint-disable-next-line no-control-regex -- intentional: strip ANSI/control
  const ansiRe = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
  // oxlint-disable-next-line no-control-regex -- intentional: strip control chars
  const ctrlRe = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
  await watchAppend(
    logPath,
    buf.length,
    (chunk) => {
      const text = new TextDecoder().decode(chunk).replace(ansiRe, "").replace(ctrlRe, "");
      if (text.trim()) process.stdout.write(text.trimStart());
    },
    () => {},
  );
  return 0;
}

/**
 * Minimal view of an @xterm/headless buffer — just what the line-finalization
 * logic needs, so it can be unit-tested against a real Terminal or a stub.
 */
export interface PlainTermView {
  buffer: {
    active: {
      baseY: number;
      cursorY: number;
      getLine(i: number): { translateToString(trim: boolean): string } | undefined;
    };
  };
}

/** Absolute index (scrollback + viewport row) of the row the cursor sits on. */
export function cursorAbs(term: PlainTermView): number {
  return term.buffer.active.baseY + term.buffer.active.cursorY;
}

/**
 * The lines in [fromAbs, cursorRow) — rows the cursor has moved PAST, i.e.
 * finalized text. A row still being rewritten in place (spinner, progress bar,
 * TUI repaint) is the cursor's own row and is excluded until the cursor leaves
 * it, which is what keeps redraw churn out of the plain stream.
 */
export function finalizedLines(term: PlainTermView, fromAbs: number): string[] {
  const a = term.buffer.active;
  const cur = a.baseY + a.cursorY;
  const out: string[] = [];
  for (let i = Math.max(0, fromAbs); i < cur; i++) {
    const l = a.getLine(i);
    out.push(l ? l.translateToString(false).trimEnd() : "");
  }
  return out;
}

/**
 * Plain (pipe/script) follow: feed the live PTY stream through @xterm/headless
 * and emit each line only once it's finalized — i.e. once the cursor has moved
 * off it. In-place redraws (spinners, progress bars that rewrite the current
 * line, full-screen TUI repaints) churn the cursor's row and never emit until
 * settled, so the output is clean, newline-terminated, line-buffered text a
 * script can read. On stop, flush the line the cursor is still sitting on.
 */
async function followPlainLocal(logPath: string, buf: Uint8Array): Promise<number> {
  process.stderr.write(`following... (plain; Ctrl-C / SIGTERM to stop)\n`);
  const { Terminal } = await import("@xterm/headless");
  const term = new Terminal({ cols: 200, rows: 50, scrollback: 50000, allowProposedApi: true });
  const feed = (b: Uint8Array) => new Promise<void>((r) => term.write(b, () => r()));
  const lineAt = (i: number) => {
    const l = term.buffer.active.getLine(i);
    return l ? l.translateToString(false).trimEnd() : "";
  };

  // Seed with the existing log so we start streaming from the live frontier —
  // the recent context was already printed by the static tail above.
  await feed(buf);
  let emitted = cursorAbs(term);

  // `emitted` only advances, so a redraw that moves the cursor back up doesn't
  // re-emit lines it then rewrites.
  const flushCommitted = () => {
    for (const line of finalizedLines(term, emitted)) process.stdout.write(line + "\n");
    emitted = cursorAbs(term);
  };

  await watchAppend(
    logPath,
    buf.length,
    async (chunk) => {
      await feed(chunk);
      flushCommitted();
    },
    () => {
      // Final flush: include the cursor's own row if it has content, so the last
      // partial line isn't lost when we're killed mid-stream.
      flushCommitted();
      const last = lineAt(cursorAbs(term));
      if (last) process.stdout.write(last + "\n");
    },
  );
  return 0;
}

/**
 * The agent's real PTY geometry (from readPtysize), passed to the renderers so
 * the raw log replays at the size it was authored for. Omitted → a wide 200x50
 * default; if the agent ran wider/taller than that its cursor-addressed redraw
 * frames undershoot on replay and strand into scrollback as duplicates (the
 * `ay tail` stutter this guards).
 */
type RenderGeom = { cols?: number; rows?: number };

/**
 * Read an agent's last-known PTY geometry from `~/.agent-yes/ptysize/<pid>`
 * (written by both runtimes — ts/index.ts and rs/src/pty_spawner.rs — as
 * "<cols> <rows>\n"). Returns null when there's no sidecar (older agent, or not
 * yet written).
 */
export async function readPtysize(pid: number): Promise<{ cols: number; rows: number } | null> {
  const dir = process.env.AGENT_YES_HOME ?? path.join(homedir(), ".agent-yes");
  try {
    const txt = await readFile(path.join(dir, "ptysize", String(pid)), "utf-8");
    const [c = 0, r = 0] = txt.trim().split(/\s+/).map(Number);
    if (c > 0 && r > 0) return { cols: c, rows: r };
  } catch {
    /* no ptysize sidecar */
  }
  return null;
}

/**
 * Feed the raw PTY bytes through @xterm/headless and emit plain text.
 * Same approach as koho's renderTerminalBuffer + agent-yes's XtermProxy.
 */
export async function renderRawLog(
  buf: Uint8Array,
  { mode, n, cols, rows }: { mode: "cat" | "tail" | "head"; n: number } & RenderGeom,
): Promise<string> {
  const lines = await renderRawLogLines(buf, { cols, rows });
  if (mode === "cat") return lines.join("\n");
  if (mode === "tail") return lines.slice(Math.max(0, lines.length - n)).join("\n");
  return lines.slice(0, n).join("\n");
}

/**
 * Render the raw PTY byte stream to its full array of scrollback lines (trailing
 * blanks trimmed). This is the substrate `renderRawLog` slices by mode and that
 * pagination (`resolveReadWindow`) indexes into — slicing the FINAL rendered
 * state is sound, but rendering from an arbitrary mid-stream offset is not (PTY
 * cursor moves / clears / wraps), so we always render the whole buffer once and
 * window the resulting lines.
 */
export async function renderRawLogLines(buf: Uint8Array, geom?: RenderGeom): Promise<string[]> {
  // Replay at the agent's real geometry when known (see RenderGeom / readPtysize);
  // otherwise fall back to a wide 200x50 — a reasonable upper bound that won't
  // truncate normal output, though an agent wider/taller than it can still
  // duplicate on replay (which is why callers pass the recorded size).
  const cols = geom?.cols && geom.cols > 0 ? geom.cols : 200;
  const rows = geom?.rows && geom.rows > 0 ? geom.rows : 50;
  // Scrollback caps how far back pagination can reach; older lines are evicted.
  const scrollback = 50000;

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
    return lines;
  } catch {
    // Fallback: regex strip ANSI
    let text = new TextDecoder().decode(buf);
    // oxlint-disable-next-line no-control-regex -- intentional: strip ANSI
    const ansi = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
    // oxlint-disable-next-line no-control-regex -- intentional: strip control
    const ctrl = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
    text = text.replace(ansi, "").replace(ctrl, "");
    const lines = text.split("\n");
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }
}

/** Half-open line window `[start, end)`, 0-indexed, into the rendered lines. */
export interface ReadWindow {
  start: number;
  end: number;
}

export const READ_PAGE_DEFAULT = 96;

/**
 * Resolve which rendered lines to show. Precedence (first match wins):
 *   1. `range` "A:B"        — explicit 1-indexed inclusive window
 *   2. `beforeLine` (+limit)— the page of `limit` lines ending just ABOVE line L
 *                             (the pagination cursor `ay read` prints in its footer)
 *   3. `head` / `last`      — explicit first/last N rendered lines
 *   4. mode preset + `-n`   — tail/head default to the last/first N (96); cat = all
 * Indices are clamped to `[0, total]`; an empty / non-matching `range` falls through.
 */
export function resolveReadWindow(opts: {
  total: number;
  mode: "cat" | "tail" | "head";
  n?: number;
  last?: number;
  head?: number;
  range?: string;
  beforeLine?: number;
  limit?: number;
}): ReadWindow {
  const total = Math.max(0, Math.floor(opts.total));
  const clamp = (v: number) => Math.max(0, Math.min(total, Math.floor(v)));
  const pos = (v: number | undefined) =>
    v != null && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;

  const range = opts.range?.trim();
  if (range) {
    const m = /^(\d+):(\d+)$/.exec(range);
    if (m) {
      const a = parseInt(m[1]!, 10);
      const b = parseInt(m[2]!, 10);
      return { start: clamp(Math.min(a, b) - 1), end: clamp(Math.max(a, b)) };
    }
  }

  if (opts.beforeLine != null && Number.isFinite(opts.beforeLine)) {
    const limit = pos(opts.limit) ?? READ_PAGE_DEFAULT;
    const end = clamp(opts.beforeLine - 1); // lines strictly before the cursor line
    return { start: clamp(end - limit), end };
  }

  const head = pos(opts.head);
  if (head != null) return { start: 0, end: clamp(head) };
  const last = pos(opts.last);
  if (last != null) return { start: clamp(total - last), end: total };

  const n = pos(opts.n);
  if (opts.mode === "head") return { start: 0, end: clamp(n ?? READ_PAGE_DEFAULT) };
  if (opts.mode === "tail") return { start: clamp(total - (n ?? READ_PAGE_DEFAULT)), end: total };
  return { start: 0, end: total }; // cat / read: whole log
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

/**
 * Extract the agent's current task progress ({done,total}) from its rendered TUI
 * screen — works for every CLI since the source is the drawn todo block, not a
 * CLI-specific session file. Reads a generous tail (the latest todo block can be
 * scrolled well back from the very last lines), renders the whole window through
 * xterm so reflow/redraw frames collapse to coherent text, then scans for the
 * most recent ⎿-anchored block. Returns null when none is confidently detected.
 */
export async function extractTaskCounts(logPath: string): Promise<TaskCounts | null> {
  // Larger window than activity: a todo block is often pushed up by later output.
  const TAIL_BYTES = 256 * 1024;
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
    // mode "cat" renders the full window so parseTaskCounts can find the most
    // recent block anywhere in it (not just the last n lines).
    const rendered = await renderRawLog(buf, { mode: "cat", n: 0 });
    return parseTaskCounts(rendered.split("\n"));
  } catch {
    return null;
  }
}

// Shared CLI defaults (ready/working/needsInput patterns), loaded once per
// process from default.config.yaml. Type-only import of AgentCliConfig keeps the
// heavy ts/index.ts module out of the `ay ls`/`ay status` startup path.
let _cliDefaults: Promise<Record<string, AgentCliConfig>> | null = null;
function cliDefaults(): Promise<Record<string, AgentCliConfig>> {
  return (_cliDefaults ??= loadSharedCliDefaults().catch(
    () => ({}) as Record<string, AgentCliConfig>,
  ));
}

/**
 * Detect whether the agent is blocked on an interactive selection menu it didn't
 * auto-resolve (state `needs_input`). Reads the same 32 KB tail as extractActivity
 * and renders it through xterm, then runs the CLI's `needsInput`/`working`
 * patterns. Returns null when no menu is detected (or the CLI defines none).
 */
/**
 * Render the last `n` lines of a raw PTY log (reads only the final 32KB). Returns
 * null on any read/render error or an empty log. Shared by the needs_input and
 * stuck classifiers so they don't each re-implement the tail read.
 */
export async function renderLogTailLines(logPath: string, n = 40): Promise<string[] | null> {
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
    return (await renderRawLog(buf, { mode: "tail", n })).split("\n");
  } catch {
    return null;
  }
}

export async function extractNeedsInput(logPath: string, cli: string): Promise<NeedsInput | null> {
  const cfg = (await cliDefaults())[cli];
  if (!cfg?.needsInput?.length) return null;
  const lines = await renderLogTailLines(logPath, 40);
  if (!lines) return null;
  return classifyNeedsInput(lines, { needsInput: cfg.needsInput, working: cfg.working });
}

/**
 * Which badges (see badges.ts) match an agent's current screen — the same 32 KB
 * tail window `ay tail` renders, no CLI-specific config needed. Returns [] on
 * any read/render error or an empty log, same failure shape as extractNeedsInput.
 */
export async function extractBadges(logPath: string): Promise<string[]> {
  const lines = await renderLogTailLines(logPath, 40);
  if (!lines) return [];
  return matchBadges(lines);
}

// Window within which a recorded human keystroke still counts as "the user is
// typing" — lights the chip and makes `ay send` back off. Comfortably longer
// than the Rust writer's throttle (STDIN_ACTIVITY_THROTTLE_MS) so continuous
// typing never flickers off between writes.
export const TYPING_WINDOW_MS = 3000;

// Path to the Rust runner's per-pid stdin-activity marker — the tiny file it
// stamps with the unix-ms of the user's last terminal keystroke (never `ay
// send`/FIFO input). Mirrors rs/src/fifo.rs `stdin_activity_path`; a plain file
// on all platforms (unlike the FIFO, which is a named pipe on Windows).
export function stdinActivityPath(pid: number): string {
  return path.resolve(agentYesHome(), "activity", `${pid}.stdin`);
}

// Epoch-ms of the user's most recent keystroke at this agent's terminal, or
// null if never/at rest. A missing or unparseable marker just means "not
// typing" — this is a best-effort liveness hint, never a hard signal.
export async function lastStdinAt(pid: number): Promise<number | null> {
  const raw = await readFile(stdinActivityPath(pid), "utf-8").catch(() => null);
  if (raw === null) return null;
  const ms = Number(raw.trim());
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

// Whether the user typed at this agent's terminal within `windowMs`.
export async function isUserTyping(pid: number, windowMs = TYPING_WINDOW_MS): Promise<boolean> {
  const at = await lastStdinAt(pid);
  return at !== null && Date.now() - at <= windowMs;
}

/**
 * Whether an alive agent is wedged: its log has been silent for at least
 * STUCK_THRESHOLD_MS yet its screen still shows a `working` busy marker (a live
 * spinner keeps writing, so busy + long-silent = a mid-stream stall). Pass the
 * already-stat'd log mtime to skip a redundant stat. Returns false when the CLI
 * has no `working` markers configured (nothing to key off).
 */
export async function isAgentStuck(
  record: GlobalPidRecord,
  logMtimeMs?: number | null,
): Promise<boolean> {
  if (!record.log_file) return false;
  const cfg = (await cliDefaults())[record.cli];
  if (!cfg?.working?.length) return false;
  const mtime =
    logMtimeMs ??
    (await stat(record.log_file)
      .then((s) => s.mtimeMs)
      .catch(() => null));
  if (mtime === null || Date.now() - mtime < STUCK_THRESHOLD_MS) return false;
  const lines = await renderLogTailLines(record.log_file, 40);
  if (!lines) return false;
  return isWorkingScreen(lines, cfg.working);
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
// ay spawn — launch an agent on a REMOTE host (POSTs the remote's /api/spawn)
// ---------------------------------------------------------------------------

async function cmdSpawn(rest: string[]): Promise<number> {
  const y = yargs(rest)
    .usage("Usage: ay spawn <remote> [--cli claude] [--cwd <dir>] [--from <src>] -- <prompt>")
    .option("cli", {
      type: "string",
      default: "claude",
      description: "CLI to wrap (claude|codex|gemini|…)",
    })
    .option("cwd", {
      type: "string",
      description: "Working dir ON THE REMOTE (resolved against the remote's workspace root)",
    })
    .option("from", {
      type: "string",
      description: "Provision a worktree from a GitHub source (owner/repo@branch) on the remote",
    })
    .option("prompt", { type: "string", description: "Initial prompt (or pass it after `--`)" })
    .help(false)
    .version(false)
    .exitProcess(false);

  const argv = await y.parseAsync();
  const target = argv._[0] !== undefined ? String(argv._[0]) : undefined;
  if (!target)
    throw new Error("usage: ay spawn <remote> [--cli X] [--cwd D] [--from S] -- <prompt>");
  const prompt = String(argv.prompt ?? argv._.slice(1).map(String).join(" "));

  // v1 is remote-only: local spawning is just running the agent directly. A
  // target that doesn't resolve as a remote is almost certainly a mistake (e.g.
  // passing a cli name), so fail loudly with the local equivalent.
  const remote = await resolveRemoteSpec(target);
  if (!remote) {
    process.stderr.write(
      `ay spawn: '${target}' is not a known remote (token@host:port or a saved alias).\n` +
        `  to spawn locally:  ay ${argv.cli}${prompt ? ` -- "${prompt}"` : ""}\n` +
        `  to add a remote:   ay remote add <alias> http://<token>@<host>:<port>\n`,
    );
    return 1;
  }
  if (remote.keyword) {
    process.stderr.write(
      `ay spawn: target '${target}' carries a ':${remote.keyword}' keyword — spawn takes a remote, ` +
        `not an existing agent. Drop the ':${remote.keyword}'.\n`,
    );
    return 1;
  }

  return runRemoteSpawn(remote, target, {
    cli: String(argv.cli || "claude"),
    cwd: argv.cwd ? String(argv.cwd) : undefined,
    from: argv.from ? String(argv.from) : undefined,
    prompt: prompt || undefined,
  });
}

// ---------------------------------------------------------------------------
// ay send / ay key / ay select — inject input into a live agent
// ---------------------------------------------------------------------------

/**
 * Shared safety gate for every command that writes to a live agent's stdin
 * (`send`, `key`, `select`): refuse a self-targeting loop, and require that THIS
 * sender actually looked at THIS target recently — an agent is blocked, an
 * interactive human is only warned — unless `force`. Returns the sender context
 * so a caller can reuse it (e.g. `send`'s `<ay-msg …>` header). Extracted from
 * cmdSend so the action commands enforce the identical guard.
 */
async function enforceSendGuards(
  record: GlobalPidRecord,
  force: boolean,
): Promise<{ key: string; agent: GlobalPidRecord | null }> {
  const sender = await senderContext();

  // Self-send guard: an agent firing at its own pid is almost always a loop.
  if (sender.agent && sender.agent.pid === record.pid && !force) {
    throw new Error(
      `refusing to send to yourself (pid ${record.pid}) — pass --force if you really mean it.`,
    );
  }

  // Recency guard: require that THIS sender tailed THIS resolved target within
  // the window. Catches a fuzzy keyword resolving to an agent you never looked
  // at. Agents are blocked (override with --force / AGENT_YES_FORCE_SEND=1);
  // an interactive human shell is only warned.
  const last = await lastReadAt(sender.key, record.pid);
  const fresh = last !== null && Date.now() - last <= READ_WINDOW_MS;
  if (!fresh && !force) {
    const ago =
      last === null ? "never read" : `last read ${Math.round((Date.now() - last) / 1000)}s ago`;
    const what = `pid ${record.pid} (${record.cli}, ${shortenPath(record.cwd)}) — ${ago}, not within ${READ_WINDOW_MS / 1000}s`;
    if (sender.agent) {
      throw new Error(
        `${what}.\n  Confirm it's the right agent first:  ay tail ${record.pid}\n  then resend, or pass --force to override.`,
      );
    }
    process.stderr.write(
      `warning: ${what} — make sure this is the agent you meant (ay tail ${record.pid}).\n`,
    );
  }
  return sender;
}

// Inter-keystroke pace (ms) for `ay key` / `ay select`. Fast enough to feel
// instant, slow enough that the CLI's input loop registers each key as a
// discrete event instead of coalescing the burst into a bracketed paste — claude
// treats a fast multi-byte blob as pasted text (see the run loop's paste guard),
// which would drop arrow keys into the composer instead of moving the menu.
const KEY_PACE_MS = 40;

/**
 * The named-key sequence that moves a menu cursor from `cursor` to option
 * `target` and confirms: |Δ| Downs (target below) or Ups (target above), then
 * Enter. Pure so the arrow arithmetic is unit-tested independent of any live PTY.
 */
export function menuSelectKeys(cursor: number, target: number): string[] {
  const delta = target - cursor;
  const nav = Array(Math.abs(delta)).fill(delta > 0 ? "down" : "up");
  return [...nav, "enter"];
}

/** Write each already-encoded key sequence to the FIFO with a pace gap between
 * them (no gap after the last). Raw bytes, no `[from]` framing, no auto-Enter. */
export async function writeKeysPaced(
  fifoPath: string,
  byteSeqs: string[],
  paceMs: number,
): Promise<void> {
  for (let i = 0; i < byteSeqs.length; i++) {
    if (byteSeqs[i] === "") continue; // `none`/empty — nothing to send
    await writeToIpc(fifoPath, byteSeqs[i]!);
    if (i < byteSeqs.length - 1 && paceMs > 0) {
      await new Promise((r) => setTimeout(r, paceMs));
    }
  }
}

/**
 * The selection menu a needs_input agent is parked on, or null when it isn't on
 * one. Mirrors extractNeedsInput (same 32 KB tail render + config patterns) but
 * returns the cursor position + option numbers so `ay select` can compute the
 * cursor delta.
 */
export async function extractMenu(logPath: string, cli: string): Promise<MenuState | null> {
  const cfg = (await cliDefaults())[cli];
  if (!cfg?.needsInput?.length) return null;
  const lines = await renderLogTailLines(logPath, 40);
  if (!lines) return null;
  return parseMenu(lines, { needsInput: cfg.needsInput, working: cfg.working });
}

/**
 * Poll `logFile`'s size until it goes `quietMs` without changing, or `maxWaitMs`
 * total elapses (whichever first). Returns the final observed size, or null if
 * the file can't be stat'd. Used by `ay send` both to wait out a paste's render
 * (before submitting) and to detect whether a submit actually produced output
 * (after submitting).
 */
export async function waitForLogQuiet(
  logFile: string,
  quietMs: number,
  maxWaitMs: number,
): Promise<number | null> {
  const pollMs = 50;
  let lastSize: number | null = null;
  let lastChangeAt = Date.now();
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const size = await stat(logFile)
      .then((s) => s.size)
      .catch(() => null);
    if (size === null) return null;
    if (size !== lastSize) {
      lastSize = size;
      lastChangeAt = Date.now();
    } else if (Date.now() - lastChangeAt >= quietMs) {
      return lastSize;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return lastSize;
}

/**
 * Block while the user is typing at `pid`'s terminal, so `ay send` doesn't inject
 * mid-line. Polls the stdin-activity marker every SEND_TYPING_POLL_MS until the
 * user pauses (last keystroke older than the typing window) or `maxWaitMs`
 * elapses. Returns `{ clear, waitedMs }`: `clear` is true if they paused, false
 * if still typing at the deadline (caller sends anyway, with a warning).
 */
export async function backoffWhileTyping(
  pid: number,
  maxWaitMs: number,
): Promise<{ clear: boolean; waitedMs: number }> {
  const start = Date.now();
  const deadline = start + maxWaitMs;
  let waited = false;
  while (Date.now() < deadline) {
    if (!(await isUserTyping(pid))) return { clear: true, waitedMs: waited ? Date.now() - start : 0 };
    waited = true;
    await new Promise((r) => setTimeout(r, SEND_TYPING_POLL_MS));
  }
  return { clear: false, waitedMs: Date.now() - start };
}

/**
 * Send the trailing submit code and confirm the CLI actually acted on it —
 * either a `working` busy marker appears, or the log grows meaningfully. Retries
 * (re-sending just the trailing code) up to SEND_SUBMIT_MAX_RETRIES times when
 * neither shows, since a swallowed Enter looks identical to a slow one until we
 * check. Returns whether submission was confirmed, plus the final rendered tail
 * (for a caller to show the user when it wasn't).
 */
export async function submitAndConfirm(
  record: GlobalPidRecord,
  fifoPath: string,
  trailing: string,
): Promise<{ confirmed: boolean; screen: string[] }> {
  const logFile = record.log_file!;
  const cfg = (await cliDefaults())[record.cli];
  let screen: string[] = [];
  for (let attempt = 0; attempt <= SEND_SUBMIT_MAX_RETRIES; attempt++) {
    const sizeBefore =
      (await stat(logFile)
        .then((s) => s.size)
        .catch(() => null)) ?? 0;
    // A working marker already on screen BEFORE this attempt (e.g. a busy agent
    // that queues typed input) proves nothing about whether THIS Enter landed —
    // it could just be leftover from whatever the agent was already doing. Only
    // a working marker that WASN'T there before, or actual log growth, counts.
    const wasAlreadyWorking = isWorkingScreen(
      (await renderLogTailLines(logFile, 40)) ?? [],
      cfg?.working,
    );
    await writeToIpc(fifoPath, trailing);
    const sizeAfter = await waitForLogQuiet(logFile, SEND_CONFIRM_QUIET_MS, SEND_CONFIRM_MAX_MS);
    screen = (await renderLogTailLines(logFile, 40)) ?? [];
    const grew = sizeAfter !== null && sizeAfter >= sizeBefore + SEND_CONFIRM_MIN_GROWTH_BYTES;
    const nowWorking = isWorkingScreen(screen, cfg?.working);
    if ((nowWorking && !wasAlreadyWorking) || grew) return { confirmed: true, screen };
  }
  return { confirmed: false, screen };
}

/** Poll until the agent is no longer parked on a menu (selection accepted → it
 * resumed / moved on) or the deadline passes. Returns true if it cleared. */
async function waitForNeedsInputClear(
  record: GlobalPidRecord,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const snap = await snapshotStatus(record);
    if (snap.state !== "needs_input") return true;
  }
  return false;
}

async function cmdSend(rest: string[]): Promise<number> {
  const y = yargs(rest)
    // Disable yargs' `--no-<flag>` negation: without this, `--no-wait` is parsed
    // as negating a phantom `wait` option (argv.wait=false) instead of setting our
    // explicitly-defined `no-wait`/`noWait` flag — so `--no-wait` silently did
    // nothing and still ran the (blocking) submit-confirm. The `--async` alias
    // masked this. No option here has a meaningful `--no-` form to lose.
    .parserConfiguration({ "boolean-negation": false })
    .usage("Usage: ay send <keyword> <msg|-> [options]")
    .option("code", {
      type: "string",
      default: "enter",
      description: "Trailing control code (enter|esc|ctrl-c|ctrl-y|tab|none)",
    })
    .option("all", { type: "boolean", default: false, description: "Include exited agents" })
    .option("latest", { type: "boolean", default: false, description: "Use most recent match" })
    .option("cwd", { type: "string", description: "Restrict to agents under this dir" })
    .option("force", {
      type: "boolean",
      default: false,
      description:
        "Skip the 'tailed recently' safety check and the wait-while-user-typing backoff (also: AGENT_YES_FORCE_SEND=1)",
    })
    .option("no-wait", {
      type: "boolean",
      default: false,
      alias: "async",
      description:
        "Fire-and-forget: skip the paste-settle wait and submit confirmation, don't retry a swallowed Enter (also: AGENT_YES_SEND_NO_WAIT=1)",
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

  // Misdelivery guard: when the keyword isn't a plain pid (an exact identity),
  // it resolved by cwd/cli/prompt substring — which can silently land on an
  // unintended session in another tree (resolveOne returns a lone fuzzy match
  // with no prompt). Echo exactly where it resolved to stderr BEFORE injecting,
  // so the sender can catch a wrong target instead of only finding out when the
  // reply never comes. Numeric identity sends stay quiet.
  if (!/^\d+$/.test(keyword)) {
    process.stderr.write(
      `ay send → pid ${record.pid} ${record.cli} @ ${shortenPath(record.cwd)}\n`,
    );
  }

  const fifoPath = record.fifo_file;
  if (!fifoPath) {
    throw new Error(
      `pid ${record.pid}: no fifo_file recorded — this agent didn't register a stdin FIFO (an older agent, or one not started with --stdpush). Restarting it (ay restart ${record.pid}) re-registers one.`,
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

  // Who's sending, and have they actually looked at this target recently?
  const force = Boolean(argv.force) || process.env.AGENT_YES_FORCE_SEND === "1";
  const sender = await enforceSendGuards(record, force);

  // A bare "exit" / "/exit" isn't a prompt to type — claude only honours the
  // literal `/exit` command, so `ay send <pid> exit` lands as plain text and the
  // model just replies "Exiting…" while the process keeps running. Route an exact
  // exit request to a real graceful shutdown instead, recording who asked.
  if (isExitRequest(body)) {
    const reason = sender.agent
      ? `requested by ${sender.agent.cli} #${sender.agent.pid} @ ${shortenPath(sender.agent.cwd)}`
      : `requested via 'ay send ${keyword} exit'`;
    const { strategy } = await gracefulExitAgent(record, reason);
    process.stdout.write(
      `pid ${record.pid} (${record.cli}): exit requested — sent ${strategy} (${reason})\n`,
    );
    return 0;
  }

  // When an agent sends, prefix one line so the recipient knows who pinged it
  // and exactly how to reply. Reply to the sender's stable agent_id, NOT its pid:
  // a pid is invalidated the moment the sender restarts (new pid), silently
  // breaking the reply route; the agent_id is preserved across restart (see
  // cmdRestart's AGENT_YES_AGENT_ID injection), so the route survives. The `#pid`
  // stays in the header for human readability. Fall back to the pid only for a
  // legacy agent with no recorded agent_id. BUT a slash command is only
  // recognized when `/` is the very first character of the submitted message; the
  // prefix would bump it to line 2 and the CLI would type the command as plain
  // text. So skip the prefix for a command body and send it verbatim —
  // attribution is dropped for the command, but it actually runs.
  // The header/footer pair shares a random nonce so the recipient can trust the
  // block's boundaries: text INSIDE the body can't forge a matching open/close
  // marker (the nonce is generated here, after the body was authored), so a
  // spoofed "[from …]" line or a premature "</ay-msg …>" embedded in a message.
  // XML-style tags (not [brackets]): LLM recipients pattern-match <tag>…</tag>
  // pairs as structural containers far more reliably, and the closing tag keeps
  // the nonce because nonce-match — not tag syntax — is what makes it forgery-
  // proof, so strict-XML validity is deliberately sacrificed for that.
  // can't impersonate another sender or truncate/extend the trusted region.
  const replyTarget = sender.agent?.agent_id || sender.agent?.pid;
  let prefix = "";
  let suffix = "";
  let nonce: string | undefined;
  if (sender.agent && !isSlashCommand(body)) {
    nonce = randomBytes(4).toString("hex");
    prefix = `<ay-msg ${nonce} from ${sender.agent.cli} #${sender.agent.pid} @ ${shortenPath(sender.agent.cwd)} — reply: ay send ${replyTarget} "...">\n`;
    suffix = `\n</ay-msg ${nonce}>`;
  }

  const fullBody = prefix + body + suffix;
  const noWait = Boolean(argv.noWait) || process.env.AGENT_YES_SEND_NO_WAIT === "1";

  // Back off while the user is typing at the target's terminal — injecting our
  // body mid-line fuses into their text and submits a mangled line. Only for a
  // real text body; skipped for --force (caller means it), --no-wait
  // (fire-and-forget), and empty bodies (a bare esc/ctrl-c interrupt is usually
  // intentional and time-sensitive). Sends anyway after the deadline so a
  // message is never silently dropped.
  if (fullBody && !noWait && !force) {
    const { clear, waitedMs } = await backoffWhileTyping(record.pid, SEND_TYPING_MAX_WAIT_MS);
    if (!clear) {
      process.stderr.write(
        `warning: user still typing at pid ${record.pid} after ${Math.round(waitedMs / 1000)}s — ` +
          `sending anyway (may interleave with their line). Use --force to skip this wait.\n`,
      );
    } else if (waitedMs > 0) {
      process.stderr.write(
        `waited ${Math.round(waitedMs / 1000)}s for the user to pause typing before sending.\n`,
      );
    }
  }
  // Submit-confirm only applies to an actual submit (Enter/CR) with a body and a
  // log to watch — other trailing codes (esc/ctrl-c/tab/none) don't have a "did
  // it land" signal in the same sense, and retrying e.g. ctrl-c could
  // double-interrupt. Checked against the resolved byte, not the code NAME, so
  // every alias that resolves to Enter (--code=enter or --code=cr) is covered.
  const canConfirm = trailing === "\r" && Boolean(fullBody) && !noWait;
  let confirmed = true;
  let lastScreen: string[] = [];
  if (fullBody && trailing) {
    await writeToIpc(fifoPath, fullBody);
    if (canConfirm && record.log_file) {
      // Wait for the paste to actually finish rendering — a long/multi-line body
      // can take longer than any fixed guess, and sending Enter mid-paste gets
      // swallowed by the CLI's bracketed-paste handling instead of submitting.
      await waitForLogQuiet(record.log_file, SEND_SETTLE_QUIET_MS, SEND_SETTLE_MAX_MS);
      ({ confirmed, screen: lastScreen } = await submitAndConfirm(record, fifoPath, trailing));
    } else {
      await new Promise((r) => setTimeout(r, 200));
      await writeToIpc(fifoPath, trailing);
    }
  } else {
    await writeToIpc(fifoPath, fullBody + trailing);
  }
  const payload = body + trailing;
  const status = confirmed ? "sent" : "sent but NOT confirmed submitted";
  process.stdout.write(
    `${status} to pid ${record.pid} (${record.cli}): ${truncate(payload, 80)}\n`,
  );

  // Persist a durable record of the exchange from both ends' point of view (the
  // sender's outbox + the recipient's inbox). Only real message bodies are
  // logged — a bare control code (esc/ctrl-c with no body) isn't a "message".
  // Best-effort: recordMessage swallows its own errors so it never breaks send.
  if (body) {
    await recordMessage({
      at: Date.now(),
      nonce,
      from: sender.agent
        ? {
            pid: sender.agent.pid,
            cli: sender.agent.cli,
            cwd: sender.agent.cwd,
            agent_id: sender.agent.agent_id,
          }
        : null,
      to: {
        pid: record.pid,
        cli: record.cli,
        cwd: record.cwd,
        agent_id: record.agent_id,
      },
      body,
      code: trailing === "\r" ? undefined : codeName,
      confirmed,
      wrapped: Boolean(nonce),
    });
  }
  if (!confirmed) {
    process.stderr.write(
      `\nwarning: couldn't confirm the CLI acted on it after ${SEND_SUBMIT_MAX_RETRIES + 1} attempt(s) — ` +
        `it may still be sitting unsubmitted in the prompt. Last screen:\n` +
        lastScreen
          .slice(-8)
          .map((l) => `  ${l}`)
          .join("\n") +
        "\n",
    );
  }

  const replyHint = sender.agent
    ? `  ay send ${replyTarget} "..."              # reply to sender\n`
    : "";
  process.stderr.write(
    `\n` +
      replyHint +
      `  ay tail ${record.pid}                  # watch output\n` +
      `  ay ls                                  # list all agents\n`,
  );
  if (codeName === "ctrl-c" || codeName === "ctrlc") {
    const tip = stopTipForCli(record.cli, record.pid);
    if (tip) process.stderr.write(tip);
  }
  return confirmed ? 0 : 1;
}

// ---------------------------------------------------------------------------
// ay msgs — read the durable inter-agent message log
// ---------------------------------------------------------------------------

/** A mailbox record annotated with the direction it takes from the owner's POV. */
interface DirectedMessage {
  dir: "in" | "out";
  rec: MessageRecord;
}

/**
 * `ay msgs [keyword]` — show the inter-agent messages an agent sent and
 * received. With no keyword it uses THIS caller's context (the agent running
 * `ay msgs`, or the human shell's cwd); with a keyword it resolves one agent and
 * reads that agent's mailboxes. Newest last, like a chat log.
 */
async function cmdMsgs(rest: string[]): Promise<number> {
  const y = yargs(rest)
    .usage("Usage: ay msgs [keyword] [--in|--out] [-n N] [--json]")
    .option("in", { type: "boolean", default: false, description: "Only received messages" })
    .option("out", { type: "boolean", default: false, description: "Only sent messages" })
    .option("n", { type: "number", description: "Show the last N messages (default 50)" })
    .option("json", { type: "boolean", default: false, description: "Emit raw JSONL records" })
    .option("all", { type: "boolean", default: false, description: "Include exited agents" })
    .option("latest", {
      type: "boolean",
      default: false,
      description: "Use most recent match when multiple match",
    })
    .option("cwd", { type: "string", description: "Restrict to agents under this dir" })
    .help(false)
    .version(false)
    .exitProcess(false);

  const argv = await y.parseAsync();
  const keyword = argv._[0] !== undefined ? String(argv._[0]) : undefined;

  // Whose mailbox: an explicit keyword names a target agent; otherwise the
  // calling agent (or, for a human shell, its own cwd with no agent filter).
  let ownerCwd: string;
  let ownerAgentId: string | null | undefined;
  let ownerPid: number | null | undefined;
  let ownerLabel: string;
  if (keyword) {
    const opts: CommonOpts = {
      all: argv.all,
      active: false,
      json: false,
      latest: argv.latest,
      cwdScope: typeof argv.cwd === "string" ? path.resolve(argv.cwd) : null,
    };
    const record = await resolveOne(keyword, opts);
    ownerCwd = record.cwd;
    ownerAgentId = record.agent_id;
    ownerPid = record.pid;
    ownerLabel = `pid ${record.pid} (${record.cli})`;
  } else {
    const sender = await senderContext();
    ownerCwd = sender.agent?.cwd ?? process.cwd();
    ownerAgentId = sender.agent?.agent_id;
    ownerPid = sender.agent?.pid;
    ownerLabel = sender.agent ? `pid ${sender.agent.pid} (${sender.agent.cli})` : "this shell";
  }

  const isOwner = (party: MailParty | null): boolean =>
    // A human shell (no agent context) owns only the messages it sent, which
    // carry `from: null`; match those so `ay msgs` in a plain terminal works.
    ownerAgentId || ownerPid ? partyMatches(party, ownerAgentId, ownerPid) : party === null;

  const messages: DirectedMessage[] = [];
  if (!argv.in) {
    for (const rec of await readMailbox(ownerCwd, "outbox")) {
      if (isOwner(rec.from)) messages.push({ dir: "out", rec });
    }
  }
  if (!argv.out) {
    for (const rec of await readMailbox(ownerCwd, "inbox")) {
      if (isOwner(rec.to)) messages.push({ dir: "in", rec });
    }
  }
  messages.sort((a, b) => a.rec.at - b.rec.at);

  const limit =
    argv.n !== undefined && Number.isFinite(argv.n) && argv.n! > 0 ? Math.floor(argv.n!) : 50;
  const shown = messages.slice(-limit);

  if (argv.json) {
    for (const { dir, rec } of shown) {
      process.stdout.write(JSON.stringify({ dir, ...rec }) + "\n");
    }
    return 0;
  }

  if (shown.length === 0) {
    process.stderr.write(`no messages for ${ownerLabel}.\n`);
    return 0;
  }

  for (const { dir, rec } of shown) {
    const when = new Date(rec.at).toLocaleTimeString();
    const peer =
      dir === "out"
        ? `→ ${rec.to.cli} #${rec.to.pid}`
        : `← ${rec.from ? `${rec.from.cli} #${rec.from.pid}` : "human"}`;
    const via = rec.remote ? ` (via ${rec.remote})` : "";
    const flag = rec.confirmed === false ? " (unconfirmed)" : "";
    const line = truncate(rec.body.replace(/\s+/g, " "), 100);
    process.stdout.write(`${when}  ${peer.padEnd(20)}${via}${flag}  ${line}\n`);
  }
  return 0;
}

// Resolve a keyword to one agent and return it with a writable FIFO, or throw
// with the same guidance cmdSend gives. Shared by `ay key` / `ay select`.
async function resolveWritableAgent(keyword: string, opts: CommonOpts): Promise<GlobalPidRecord> {
  const record = await resolveOne(keyword, opts);
  if (!record.fifo_file) {
    throw new Error(
      `pid ${record.pid}: no fifo_file recorded — this agent didn't register a stdin FIFO (an older agent, or one not started with --stdpush). Restarting it (ay restart ${record.pid}) re-registers one.`,
    );
  }
  return record;
}

async function cmdKey(rest: string[]): Promise<number> {
  const y = yargs(rest)
    .usage(
      "Usage: ay key <keyword> <key...> [options]\n\n" +
        "Send raw named keystrokes to a live agent's TUI — no message framing, no\n" +
        "auto-Enter. Drives selection menus and other interactive prompts that a\n" +
        "plain `ay send` (text + Enter) can't. Keys are paced so the CLI registers\n" +
        "each as a discrete event, not a paste.\n\n" +
        "Keys: up down left right enter esc tab space backspace delete home end\n" +
        "      pageup pagedown ctrl-c ctrl-d ctrl-y  raw:0xNN\n\n" +
        "Examples:\n" +
        "  ay key 1234 down down enter    # move the menu cursor down twice, confirm\n" +
        "  ay key 1234 esc                # dismiss a menu\n" +
        "  ay key 1234 raw:0x1b           # a literal ESC byte",
    )
    .option("pace", { type: "number", default: KEY_PACE_MS, description: "ms between keystrokes" })
    .option("all", { type: "boolean", default: false, description: "Include exited agents" })
    .option("latest", { type: "boolean", default: false, description: "Use most recent match" })
    .option("cwd", { type: "string", description: "Restrict to agents under this dir" })
    .option("force", {
      type: "boolean",
      default: false,
      description: "Skip the recency/self-send guard (also: AGENT_YES_FORCE_SEND=1)",
    })
    .help(false)
    .version(false)
    .exitProcess(false);

  const argv = await y.parseAsync();
  const keyword = argv._[0] !== undefined ? String(argv._[0]) : undefined;
  const keyNames = argv._.slice(1).map(String);
  if (!keyword || keyNames.length === 0) {
    throw new Error("usage: ay key <keyword> <key...>   (e.g. ay key 1234 down down enter)");
  }
  // Map every key up front so an unknown name fails before we send anything
  // (a half-sent sequence could leave a menu in a surprising state).
  const byteSeqs = keyNames.map((n) => controlCodeFromName(n.toLowerCase()));

  const opts: CommonOpts = {
    all: argv.all,
    active: false,
    json: false,
    latest: argv.latest,
    cwdScope: typeof argv.cwd === "string" ? path.resolve(argv.cwd) : null,
  };
  const record = await resolveWritableAgent(keyword, opts);
  const force = Boolean(argv.force) || process.env.AGENT_YES_FORCE_SEND === "1";
  await enforceSendGuards(record, force);

  await writeKeysPaced(record.fifo_file!, byteSeqs, Math.max(0, argv.pace));
  process.stdout.write(`sent to pid ${record.pid} (${record.cli}): ${keyNames.join(" ")}\n`);
  return 0;
}

async function cmdSelect(rest: string[]): Promise<number> {
  const y = yargs(rest)
    .usage(
      "Usage: ay select <keyword> <N> [options]\n\n" +
        "Pick option N of the selection menu a needs_input agent is parked on.\n" +
        "Re-parses the live menu (the same ❯-cursor detection `ay ls` uses), computes\n" +
        "how far the cursor must move, and sends that many Down/Up keys + Enter — so\n" +
        "it's robust to a pre-highlighted default (never assumes the cursor starts at 1)\n" +
        "and doesn't rely on numeric hotkeys (arrow-driven menus ignore them).\n\n" +
        "Examples:\n" +
        "  ay select 1234 2           # choose option 2\n" +
        "  ay select 1234 2 --wait    # …and block until the menu clears",
    )
    .option("pace", { type: "number", default: KEY_PACE_MS, description: "ms between keystrokes" })
    .option("wait", {
      type: "boolean",
      default: false,
      description: "Block until the agent leaves needs_input (or --timeout)",
    })
    .option("timeout", { type: "number", default: 10, description: "Seconds to wait with --wait" })
    .option("all", { type: "boolean", default: false, description: "Include exited agents" })
    .option("latest", { type: "boolean", default: false, description: "Use most recent match" })
    .option("cwd", { type: "string", description: "Restrict to agents under this dir" })
    .option("force", {
      type: "boolean",
      default: false,
      description: "Skip the recency/self-send guard (also: AGENT_YES_FORCE_SEND=1)",
    })
    .help(false)
    .version(false)
    .exitProcess(false);

  const argv = await y.parseAsync();
  const keyword = argv._[0] !== undefined ? String(argv._[0]) : undefined;
  const n = Number(argv._[1]);
  if (!keyword || !Number.isInteger(n) || n < 1) {
    throw new Error("usage: ay select <keyword> <N>   (N = the 1-based option number to choose)");
  }

  const opts: CommonOpts = {
    all: argv.all,
    active: false,
    json: false,
    latest: argv.latest,
    cwdScope: typeof argv.cwd === "string" ? path.resolve(argv.cwd) : null,
  };
  const record = await resolveWritableAgent(keyword, opts);
  if (!record.log_file) {
    throw new Error(
      `pid ${record.pid}: no log_file recorded — can't read the menu to select from.`,
    );
  }
  const force = Boolean(argv.force) || process.env.AGENT_YES_FORCE_SEND === "1";
  await enforceSendGuards(record, force);

  const menu = await extractMenu(record.log_file, record.cli);
  if (!menu) {
    throw new Error(
      `pid ${record.pid} (${record.cli}) is not parked on a selection menu (not needs_input).\n  Check with:  ay status ${record.pid}`,
    );
  }
  if (menu.options.length > 0 && !menu.options.includes(n)) {
    throw new Error(`option ${n} is out of range — this menu offers ${menu.options.join(", ")}.`);
  }

  // Move the cursor from where it sits to option N, then confirm. Delta from the
  // PARSED cursor position (not a blind "N-1 downs") so a non-first default works.
  const keyNames = menuSelectKeys(menu.cursor, n);
  const byteSeqs = keyNames.map((k) => controlCodeFromName(k));
  await writeKeysPaced(record.fifo_file!, byteSeqs, Math.max(0, argv.pace));

  const delta = n - menu.cursor;
  const moved =
    delta === 0 ? "cursor already there" : `${Math.abs(delta)}× ${delta > 0 ? "down" : "up"}`;
  process.stdout.write(
    `pid ${record.pid} (${record.cli}): selected option ${n} (${moved} + enter)\n`,
  );

  if (argv.wait) {
    const ok = await waitForNeedsInputClear(record, Math.max(1, argv.timeout) * 1000);
    process.stdout.write(
      ok
        ? `  menu cleared — selection accepted.\n`
        : `  still needs_input after ${argv.timeout}s — re-check with 'ay status ${record.pid}'.\n`,
    );
    return ok ? 0 : 1;
  }
  return 0;
}

/// CLIs that ignore a single Ctrl+C and need a more specific shutdown signal.
/// Users hit this every time they try `ay send <pid> "" --code=ctrl-c` and
/// see no effect — print a one-liner pointing them at `ay stop`.
export function stopTipForCli(cli: string, pid: number): string | null {
  const cmd = GRACEFUL_EXIT_COMMANDS[cli];
  if (cmd) {
    return `  tip: ${cli} ignores a single Ctrl+C — try 'ay stop ${pid}' (sends '${cmd}') or double Ctrl+C.\n`;
  }
  return null;
}

/// Per-CLI graceful shutdown commands. Empty fallback = use double Ctrl+C.
/// Verified against current upstream CLIs:
///   claude   — `/exit`
///   codex    — `/exit`
///   gemini   — `/quit`
///   bash/cmd/powershell — `exit` (the shell builtin; closes the session at a
///     bare prompt, far cleaner than Ctrl+C which would instead hit whatever
///     app is running in the foreground).
/// Other CLIs aren't in the table because their reliable graceful-exit
/// command isn't well-known here; `ay stop` falls back to double Ctrl+C.
export const GRACEFUL_EXIT_COMMANDS: Record<string, string> = {
  claude: "/exit",
  codex: "/exit",
  gemini: "/quit",
  bash: "exit",
  cmd: "exit",
  powershell: "exit",
};

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
    case "ctrl-\\":
    case "ctrl\\":
    case "ctrl-backslash":
      // FS (file separator); convenient detach key for `ay attach`
      // because few CLIs send it. Same as SIGQUIT's terminal binding,
      // but here it's intercepted before reaching any signal handler.
      return "\x1c";
    case "tab":
      return "\t";
    // Navigation / editing keys — the ANSI/xterm sequences a TUI reads as cursor
    // moves. Added for `ay key` / `ay select` so a menu can be driven from a
    // parent agent (up/down + enter picks an option) the same way a human's
    // arrow keys do in the web terminal.
    case "up":
      return "\x1b[A";
    case "down":
      return "\x1b[B";
    case "right":
      return "\x1b[C";
    case "left":
      return "\x1b[D";
    case "home":
      return "\x1b[H";
    case "end":
      return "\x1b[F";
    case "pageup":
    case "pgup":
      return "\x1b[5~";
    case "pagedown":
    case "pgdn":
      return "\x1b[6~";
    case "space":
      return " ";
    case "backspace":
    case "bs":
      return "\x7f";
    case "delete":
    case "del":
      return "\x1b[3~";
    case "none":
    case "":
      return "";
    default:
      // raw:0xNN form
      const m = /^raw:0x([0-9a-f]+)$/i.exec(name);
      if (m) return String.fromCharCode(parseInt(m[1]!, 16));
      throw new Error(`unknown key/code: ${name}`);
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
    const { openSync, writeSync, closeSync, constants } = await import("fs");
    // O_NONBLOCK on OPEN so a reader-less FIFO fails fast with ENXIO instead of
    // blocking forever — a dead agent has no one reading its stdin pipe. (No
    // O_CREAT: a missing FIFO should error, not create a bogus regular file.)
    const fd = openSync(ipcPath, constants.O_WRONLY | constants.O_NONBLOCK);
    try {
      // The WRITE, however, must deliver every byte. A single non-blocking
      // writeFileSync EAGAINs (or short-writes) the moment a busy agent's stdin
      // backs up — the FIFO kernel buffer is tiny (~8KB on macOS) — silently
      // dropping the message tail (observed: a busy agent received only the
      // "[from …]" prefix, never the body). So loop, retrying on EAGAIN / partial
      // writes while the reader drains, with a timeout so a wedged reader still
      // errors instead of hanging forever.
      const buf = Buffer.from(payload, "utf8");
      const deadline = Date.now() + IPC_WRITE_TIMEOUT_MS;
      let off = 0;
      while (off < buf.length) {
        let wrote = 0;
        try {
          wrote = writeSync(fd, buf, off, buf.length - off);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException)?.code;
          if (code !== "EAGAIN" && code !== "EWOULDBLOCK") throw e;
        }
        off += wrote;
        if (off < buf.length) {
          if (Date.now() >= deadline) {
            throw new Error(
              `writeToIpc: ${ipcPath} reader not draining — wrote ${off}/${buf.length} bytes in ${IPC_WRITE_TIMEOUT_MS}ms`,
            );
          }
          // Buffer full (EAGAIN) or a partial write — give the agent a moment to
          // drain its stdin, then continue from where we left off.
          await new Promise((r) => setTimeout(r, wrote > 0 ? 1 : 15));
        }
      }
    } finally {
      closeSync(fd);
    }
  }
}

// ---------------------------------------------------------------------------
// ay stop
// ---------------------------------------------------------------------------

async function cmdStop(rest: string[]): Promise<number> {
  const y = yargs(rest)
    .usage("Usage: ay stop <keyword> [--method=graceful|double-ctrl-c|auto]")
    .option("method", {
      type: "string",
      default: "auto",
      description:
        "Shutdown strategy: auto (per-CLI), graceful (/exit-style), double-ctrl-c (force)",
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
  if (!keyword) throw new Error("usage: ay stop <keyword> [--method=auto|graceful|double-ctrl-c]");

  const record = await resolveOne(keyword, opts);

  // Already dead? Writing to its FIFO would block forever (a reader-less named
  // pipe blocks on open). Don't try — mark it exited so `ay ls` stops showing it
  // as live, and return cleanly.
  if (!isPidAlive(record.pid)) {
    await updateGlobalPidStatus(record.pid, {
      status: "exited",
      exit_reason: "already-stopped",
    }).catch(() => {});
    process.stdout.write(`pid ${record.pid} (${record.cli}) already stopped — marked exited\n`);
    return 0;
  }

  if (!record.fifo_file) {
    throw new Error(`pid ${record.pid}: no fifo_file — cannot send shutdown command`);
  }

  const method = String(argv.method).toLowerCase();
  const graceful = GRACEFUL_EXIT_COMMANDS[record.cli];

  let payload: string;
  let strategy: string;
  if (method === "double-ctrl-c") {
    payload = "double-ctrl-c";
    strategy = `double Ctrl+C (forced)`;
  } else if (method === "graceful" || (method === "auto" && graceful)) {
    if (!graceful) {
      throw new Error(`--method=graceful: no known graceful-exit command for cli "${record.cli}"`);
    }
    payload = graceful;
    strategy = `'${graceful}' + Enter`;
  } else if (method === "auto") {
    payload = "double-ctrl-c";
    strategy = `double Ctrl+C (no known /exit for cli "${record.cli}")`;
  } else {
    throw new Error(`unknown --method=${method}`);
  }

  const fifoPath = record.fifo_file;
  if (payload === "double-ctrl-c") {
    await writeToIpc(fifoPath, "\x03");
    await new Promise((r) => setTimeout(r, 200));
    await writeToIpc(fifoPath, "\x03");
  } else {
    await writeToIpc(fifoPath, payload);
    await new Promise((r) => setTimeout(r, 200));
    await writeToIpc(fifoPath, "\r");
  }

  process.stdout.write(`stopping pid ${record.pid} (${record.cli}) via ${strategy}\n`);
  process.stderr.write(
    `\n` +
      `  ay status ${record.pid}                # confirm it exited\n` +
      `  ay ls --all                            # see exit codes\n`,
  );
  return 0;
}

/** A `send` body that is exactly the exit word (not a sentence that merely
 * contains it). Bare "exit" and the literal "/exit" both qualify. */
export function isExitRequest(body: string): boolean {
  const t = body.trim().toLowerCase();
  return t === "exit" || t === "/exit";
}

/** A body that the CLI will parse as a slash command — `/` as the very first
 * character (claude requires column 0, no leading whitespace, then a letter).
 * Such a body must be sent verbatim: any prefix line bumps the `/` off column 0
 * and the CLI types the command as plain text instead of running it. */
export function isSlashCommand(body: string): boolean {
  return /^\/[A-Za-z]/.test(body);
}

/**
 * Gracefully terminate a live agent and record WHY in its note (the audit trail
 * shown by `ay ls`). Sends the CLI's graceful-exit command (e.g. claude's
 * `/exit`) or a double-Ctrl+C fallback. `reason` is agent-yes metadata — claude's
 * `/exit` takes no argument, so the reason is the note, not appended to `/exit`.
 * Shared by `ay exit` and by `ay send <kw> exit`'s routing.
 */
async function gracefulExitAgent(
  record: GlobalPidRecord,
  reason: string,
): Promise<{ strategy: string }> {
  if (!record.fifo_file) {
    throw new Error(`pid ${record.pid}: no fifo_file — cannot send shutdown command`);
  }
  await writeNote(record.pid, `↩ exit — ${reason}`).catch(() => {});
  const fifoPath = record.fifo_file;
  const graceful = GRACEFUL_EXIT_COMMANDS[record.cli];
  if (graceful) {
    await writeToIpc(fifoPath, graceful);
    await new Promise((r) => setTimeout(r, 200));
    await writeToIpc(fifoPath, "\r");
    return { strategy: `'${graceful}' + Enter` };
  }
  await writeToIpc(fifoPath, "\x03");
  await new Promise((r) => setTimeout(r, 200));
  await writeToIpc(fifoPath, "\x03");
  return { strategy: `double Ctrl+C (no known /exit for cli "${record.cli}")` };
}

// ---------------------------------------------------------------------------
// ay exit  — graceful shutdown that records who/why (alias-ish to `ay stop`,
// and the target that `ay send <kw> exit` routes to)
// ---------------------------------------------------------------------------

async function cmdExit(rest: string[]): Promise<number> {
  const y = yargs(rest)
    .usage("Usage: ay exit <keyword> [reason]")
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
  if (!keyword) throw new Error("usage: ay exit <keyword> [reason]");
  const reasonArg = argv._.slice(1).map(String).join(" ").trim();

  const record = await resolveOne(keyword, opts);
  if (!isPidAlive(record.pid)) {
    await updateGlobalPidStatus(record.pid, {
      status: "exited",
      exit_reason: "already-stopped",
    }).catch(() => {});
    process.stdout.write(`pid ${record.pid} (${record.cli}) already stopped — marked exited\n`);
    return 0;
  }

  const sender = await senderContext();
  const reason =
    reasonArg ||
    (sender.agent
      ? `requested by ${sender.agent.cli} #${sender.agent.pid} @ ${shortenPath(sender.agent.cwd)}`
      : "manual");
  const { strategy } = await gracefulExitAgent(record, reason);
  process.stdout.write(`exiting pid ${record.pid} (${record.cli}) via ${strategy} — ${reason}\n`);
  process.stderr.write(`\n  ay status ${record.pid}                # confirm it exited\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// ay attach
// ---------------------------------------------------------------------------

async function cmdAttach(rest: string[]): Promise<number> {
  const y = yargs(rest)
    .usage("Usage: ay attach <keyword> [--escape ctrl-\\]")
    .option("escape", {
      type: "string",
      default: "ctrl-\\",
      description: "Detach key name (see --code list; default: ctrl-\\)",
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
  if (!keyword) throw new Error("usage: ay attach <keyword> [--escape ctrl-\\]");

  const escapeName = String(argv.escape).toLowerCase();
  const detachSeq = controlCodeFromName(escapeName);
  if (!detachSeq) {
    throw new Error(`--escape must resolve to a non-empty byte sequence (got "${argv.escape}")`);
  }
  const detachByte = detachSeq.charCodeAt(0);

  const record = await resolveOne(keyword, opts);
  if (!record.fifo_file) {
    throw new Error(`pid ${record.pid}: no fifo_file recorded — agent has no input channel`);
  }
  if (!record.log_file) {
    throw new Error(`pid ${record.pid}: no log_file recorded — cannot stream output`);
  }
  if (!isPidAlive(record.pid)) {
    throw new Error(`pid ${record.pid}: process is not alive`);
  }

  const fifoPath = record.fifo_file;
  const logPath = record.log_file;

  // 1. Replay the current screen via @xterm/headless so the user sees a
  //    coherent snapshot instead of half-frame ANSI garbage. Cap input bytes
  //    so multi-MB logs don't stall the attach.
  const REPLAY_CAP_BYTES = 1024 * 1024;
  let initialOffset = 0;
  let replay = "";
  try {
    const st = await stat(logPath);
    initialOffset = Number(st.size);
    if (initialOffset > 0) {
      const readStart = Math.max(0, initialOffset - REPLAY_CAP_BYTES);
      const fh = await open(logPath, "r");
      try {
        const buf = Buffer.alloc(initialOffset - readStart);
        await fh.read(buf, 0, buf.length, readStart);
        const rows = process.stdout.rows ?? 50;
        replay = await renderRawLog(buf, { mode: "tail", n: rows });
      } finally {
        await fh.close();
      }
    }
  } catch {
    /* log unreadable — show nothing */
  }

  process.stderr.write(
    `[attaching to pid ${record.pid}: ${record.cli} in ${shortenPath(record.cwd)}]\n` +
      `[detach: ${escapeName}]\n`,
  );
  if (replay) {
    process.stdout.write(replay);
    if (!replay.endsWith("\n")) process.stdout.write("\n");
  }

  // 2. Push local winsize → ~/.agent-yes/winsize/<pid>, signal SIGWINCH so
  //    the agent resizes its inner PTY before we start forwarding bytes.
  const ayHome = process.env.AGENT_YES_HOME ?? path.join(homedir(), ".agent-yes");
  const winsizeDir = path.join(ayHome, "winsize");
  await mkdir(winsizeDir, { recursive: true });
  const winsizePath = path.join(winsizeDir, String(record.pid));

  const sendResize = async () => {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    try {
      await writeFile(winsizePath, `${cols} ${rows} ${Date.now()}\n`);
      try {
        process.kill(record.pid, "SIGWINCH");
      } catch {
        /* agent died — handled by alive check */
      }
    } catch {
      /* ignore */
    }
  };
  await sendResize();
  await new Promise((r) => setTimeout(r, 50)); // let agent redraw

  // 3. Raw TTY so per-keystroke bytes flow through unchanged.
  const stdinIsTty = !!process.stdin.isTTY;
  if (stdinIsTty) {
    try {
      process.stdin.setRawMode(true);
    } catch {
      /* ignore */
    }
  }
  process.stdin.resume();

  const onResize = () => {
    void sendResize();
  };
  process.stdout.on("resize", onResize);

  // 4. Keep FIFO open across keystrokes so we don't pay open(2) per byte.
  //    Agent's RDWR keepalive means O_WRONLY does not block here.
  const { openSync, writeSync, closeSync, watch } = await import("fs");
  let fifoFd: number | null = null;
  try {
    fifoFd = openSync(fifoPath, "w");
  } catch (err) {
    throw new Error(`failed to open FIFO ${fifoPath}: ${(err as Error).message}`);
  }

  // 5. Stream new log bytes → stdout. fs.watch may coalesce on macOS, so
  //    poll every 100ms as a safety net.
  let offset = initialOffset;
  let detached = false;
  let pollTimer: NodeJS.Timeout | undefined;
  let aliveCheck: NodeJS.Timeout | undefined;

  const flushNew = async () => {
    if (detached) return;
    try {
      const st = await stat(logPath);
      if (st.size < offset) offset = 0; // truncated
      if (st.size > offset) {
        const fh = await open(logPath, "r");
        try {
          const buf = Buffer.alloc(st.size - offset);
          await fh.read(buf, 0, buf.length, offset);
          process.stdout.write(buf);
          offset = st.size;
        } finally {
          await fh.close();
        }
      }
    } catch {
      /* transient — retry */
    }
  };

  const watcher = watch(logPath, () => {
    void flushNew();
  });
  // Race fix: bytes can land between stat() above and watch() install.
  await flushNew();
  pollTimer = setInterval(() => {
    void flushNew();
  }, 100);

  // 6. Stdin → FIFO, watching for detach byte.
  const triggerDetach = () => {
    if (detached) return;
    detached = true;
    if (pollTimer) clearInterval(pollTimer);
    if (aliveCheck) clearInterval(aliveCheck);
    watcher.close();
    process.stdout.removeListener("resize", onResize);
    process.stdin.removeListener("data", onStdinData);
    if (stdinIsTty) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
    }
    process.stdin.pause();
    if (fifoFd !== null) {
      try {
        closeSync(fifoFd);
      } catch {
        /* ignore */
      }
      fifoFd = null;
    }
    process.stderr.write(`\n[detached from pid ${record.pid} — agent still running]\n`);
  };

  const onStdinData = (chunk: Buffer) => {
    if (detached) return;
    const idx = chunk.indexOf(detachByte);
    if (idx === -1) {
      try {
        if (fifoFd !== null) writeSync(fifoFd, chunk);
      } catch (err) {
        process.stderr.write(`\n[fifo write failed: ${(err as Error).message}]\n`);
        triggerDetach();
      }
      return;
    }
    if (idx > 0 && fifoFd !== null) {
      try {
        writeSync(fifoFd, chunk.subarray(0, idx));
      } catch {
        /* ignore */
      }
    }
    triggerDetach();
  };
  process.stdin.on("data", onStdinData);

  // 7. Detach automatically if the agent exits.
  aliveCheck = setInterval(() => {
    if (!isPidAlive(record.pid)) {
      process.stderr.write(`\n[pid ${record.pid} exited]\n`);
      triggerDetach();
    }
  }, 1000);

  await new Promise<void>((resolve) => {
    const tick = () => {
      if (detached) resolve();
      else setTimeout(tick, 50);
    };
    tick();
  });

  return 0;
}

// ---------------------------------------------------------------------------
// ay restart
// ---------------------------------------------------------------------------

/**
 * Decide how to relaunch an agent on `ay restart`. Pure (no I/O) so it's unit
 * testable. Precedence:
 *  - `fresh`: replay the original prompt (the old behaviour), no resume.
 *  - else if the CLI printed a resume command its `resumeCommand` regex matches
 *    in the captured log (capture group 1 = the arg string), relaunch with those
 *    whitespace-split args.
 *  - else fall back to `restoreArgs` (e.g. `--continue`) so the wrapper's own
 *    resume plumbing (claude --continue, codex stored-session) kicks in.
 */
export function resolveResumeArgs(
  conf: AgentCliConfig | undefined,
  logText: string,
  opts: { fresh: boolean; prompt?: string },
): { args: string[]; strategy: string } {
  if (opts.fresh) {
    return opts.prompt
      ? { args: [opts.prompt], strategy: "fresh (replay original prompt)" }
      : { args: [], strategy: "fresh (no prompt)" };
  }
  const re = conf?.resumeCommand;
  if (re) {
    // Strip a stray `g` flag so .exec returns capture groups deterministically.
    const probe = re.global ? new RegExp(re.source, re.flags.replace(/g/g, "")) : re;
    const m = probe.exec(logText);
    const captured = m?.[1]?.trim();
    if (captured) {
      const parts = captured.split(/\s+/).filter(Boolean);
      if (parts.length) return { args: parts, strategy: `printed resume command: ${captured}` };
    }
  }
  const restore = conf?.restoreArgs;
  if (restore && restore.length) {
    return { args: [...restore], strategy: `restoreArgs (${restore.join(" ")})` };
  }
  return { args: ["--continue"], strategy: "--continue (fallback)" };
}

/**
 * Wait for a pid to exit. No cross-process exit event exists (the agent is owned
 * by its own wrapper), so poll `isPidAlive` — checked once immediately, then with
 * golden-ratio backoff (1.0, 1.6, 2.6…s, capped) up to `timeoutMs`. Returns true
 * once the pid is gone.
 */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  if (!isPidAlive(pid)) return true;
  const start = Date.now();
  let delay = 1000;
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, delay));
    if (!isPidAlive(pid)) return true;
    delay = Math.min(Math.round(delay * 1.618), 8000);
  }
  return !isPidAlive(pid);
}

// Post-restart hint. The resumed agent's pid is NOT knowable synchronously here:
// `proc.pid` is the `agent-yes` launcher we just spawned (a wrapper/bin shim
// whose pid differs from the registered agent), and the resume itself bootstraps
// through a throwaway pid that dies before the real TUI re-registers under yet
// another pid seconds later — with a window where nothing is registered at all.
// So any pid we print here would race and usually resolve to "no agent matched"
// (the reported "restart not working"). The cwd is the one stable handle, and
// `ay tail`/`ay ls` already accept a cwd substring, so we key the hint on cwd.
export function restartHintLines(
  cli: string,
  cwd: string,
  strategy: string,
): { out: string; err: string } {
  return {
    out: `restarted ${cli} in ${shortenPath(cwd)} via ${strategy}\n`,
    err:
      `\n` +
      `the resumed agent re-registers under a new pid a moment later — reach it by cwd:\n` +
      `  ay tail -f ${cwd}   # follow the resumed agent\n` +
      `  ay ls                 # list all agents\n`,
  };
}

async function cmdRestart(rest: string[]): Promise<number> {
  const y = yargs(rest)
    .usage("Usage: ay restart <keyword> [--fresh]")
    .option("latest", { type: "boolean", default: false, description: "Use most recent match" })
    .option("cwd", { type: "string", description: "Restrict to agents under this dir" })
    .option("fresh", {
      type: "boolean",
      default: false,
      description: "Replay the original prompt instead of resuming the session",
    })
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
  const fresh = Boolean(argv.fresh);

  // Live agent: gracefully stop it (claude /exit / double-Ctrl+C via FIFO), then
  // wait for it to actually exit before relaunching.
  if (isPidAlive(record.pid)) {
    await gracefulExitAgent(record, "restart");
    process.stdout.write(`stopping pid ${record.pid} (${record.cli}) before restart…\n`);
    let exited = await waitForExit(record.pid, 30_000);
    if (!exited) {
      // Wouldn't go gracefully — SIGKILL the pid (the reaper sweeps its pgid).
      try {
        process.kill(record.pid, "SIGKILL");
      } catch {
        /* already gone / not permitted */
      }
      exited = await waitForExit(record.pid, 5_000);
    }
    if (!exited) {
      process.stderr.write(
        `pid ${record.pid} did not exit — aborting restart ` +
          `(try: ay stop ${record.pid} --method=double-ctrl-c)\n`,
      );
      return 1;
    }
  }

  // Resolve how to relaunch: a printed resume command (config `resumeCommand`),
  // else restoreArgs/--continue, else replay the prompt when --fresh.
  const conf = (await cliDefaults())[record.cli];
  const logText =
    !fresh && record.log_file ? await readFile(record.log_file, "utf8").catch(() => "") : "";
  const { args: resumeArgs, strategy } = resolveResumeArgs(conf, logText, {
    fresh,
    prompt: record.prompt,
  });

  // Detached launcher; we deliberately don't track its pid — see restartHintLines
  // for why the resumed agent's pid isn't reportable synchronously.
  //
  // Carry the old record's agent_id into the relaunch so the resumed agent keeps
  // the SAME stable id (only the pid changes). Without this the wrapper mints a
  // fresh id and any `ay send <agent_id>` reply route breaks across a restart —
  // exactly the misdelivery that made a pinned-pid reply header no-match after
  // the sender restarted. The Rust/TS wrapper adopts AGENT_YES_AGENT_ID for its
  // own record and strips it from the wrapped CLI's env (pty_spawner.rs /
  // index.ts), so subagents don't collide on the id.
  Bun.spawn(["agent-yes", "--cli=" + record.cli, ...resumeArgs], {
    cwd: record.cwd,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: record.agent_id
      ? { ...process.env, AGENT_YES_AGENT_ID: record.agent_id }
      : process.env,
  });

  const { out, err } = restartHintLines(record.cli, record.cwd, strategy);
  process.stdout.write(out);
  process.stderr.write(err);
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
  // needs_input: alive but blocked on an interactive menu (distinct from idle =
  // alive+quiet/done, and stopped = exited). stuck: alive + busy marker on screen
  // but long-silent (wedged mid-stream). See `question`.
  state: LiveState;
  activity: string | null;
  /** The pending question/menu when state === "needs_input", else null. */
  question: string | null;
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
  let state: LiveState;
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
  // A blocked interactive menu overrides active/idle — the agent is alive and
  // quiet, but quiet because it's waiting for an answer, not because it's done.
  let question: string | null = null;
  if (state !== "stopped" && record.log_file) {
    const ni = await extractNeedsInput(record.log_file, record.cli);
    if (ni) {
      state = "needs_input";
      question = ni.question;
    } else if (state === "idle" && (await isAgentStuck(record, logMtimeMs))) {
      // Quiet long enough to read "idle", but still showing a busy marker: wedged.
      state = "stuck";
    }
  }
  // The Rust supervisor's unresponsive flag is an authoritative wedge signal —
  // it overrides the log-tail heuristics above (but never a dead agent, which
  // Rust clears the flag on anyway).
  if (alive && record.unresponsive) state = "stuck";
  const notes = await readNotes();
  const note = notes.get(record.pid) ?? null;
  return {
    pid: record.pid,
    cli: record.cli,
    cwd: record.cwd,
    state,
    activity,
    question,
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
    .option("wait", {
      type: "boolean",
      default: false,
      description:
        "Block until the agent needs attention (needs_input | idle | stopped), then emit it. " +
        "Exit 0 reached, 2 timeout. The JSON `state` says which — this is the primitive an " +
        "orchestrator wants: it returns on a blocking question, not just on done.",
    })
    .option("wait-idle", {
      type: "boolean",
      default: false,
      description:
        "Block until state == idle. Exit 0 idle, 1 stopped, 2 timeout. " +
        "Does NOT return on needs_input (a blocked menu) — use --wait for that.",
    })
    .option("timeout", {
      type: "string",
      description: "Timeout for --wait/--wait-idle (e.g. 30s, 5m). Default: no timeout",
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
    throw new Error(
      "usage: ay status <keyword> [--watch | --wait | --wait-idle] [--timeout=Ns] [--cwd=DIR] [--latest]",
    );

  {
    const remote = await resolveRemoteSpec(keyword);
    if (remote) return runRemoteStatus(remote);
  }

  const watch = argv.watch;
  const wait = argv.wait;
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

  // --wait: return as soon as the ball is in the operator's court — a blocking
  // question (needs_input), a finished/quiet agent (idle), or an exit (stopped).
  // This is the fan-out primitive: a sub-agent that stops to ask no longer hides
  // behind "idle" until someone happens to look.
  if (wait) {
    const startedAt = Date.now();
    for (;;) {
      const snap = await snapshotStatus(record);
      // `stuck` is a wedged agent — also the operator's court, so wake on it too
      // (it would otherwise have read as `idle`, which this loop already wakes on).
      if (
        snap.state === "needs_input" ||
        snap.state === "idle" ||
        snap.state === "stuck" ||
        snap.state === "stopped"
      ) {
        emit(snap);
        return 0;
      }
      if (timeoutMs !== null && Date.now() - startedAt >= timeoutMs) {
        emit(snap);
        return 2;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  if (waitIdle) {
    const startedAt = Date.now();
    for (;;) {
      const snap = await snapshotStatus(record);
      // A wedged agent reads as `stuck` rather than `idle`; still treat it as
      // "quiet, your turn" so `--wait-idle` doesn't hang on a stalled stream.
      if (snap.state === "idle" || snap.state === "stuck") {
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

  let prev: {
    state: string;
    activity: string | null;
    question: string | null;
    exit_code: number | null;
  } | null = null;

  const tick = async (): Promise<void> => {
    const snap = await snapshotStatus(record);
    if (
      prev === null ||
      snap.state !== prev.state ||
      snap.activity !== prev.activity ||
      snap.question !== prev.question ||
      snap.exit_code !== prev.exit_code
    ) {
      emit(snap, Date.now());
      prev = {
        state: snap.state,
        activity: snap.activity,
        question: snap.question,
        exit_code: snap.exit_code,
      };
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

// ---------------------------------------------------------------------------
// ay result — structured completion envelope (P4)
// ---------------------------------------------------------------------------

/** Read all of stdin as a UTF-8 string (for `ay result set -` / piped JSON). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Load a persisted result envelope, or null if none has been deposited yet. */
async function loadStoredResult(pid: number): Promise<StoredResult | null> {
  try {
    const raw = await readFile(resultPath(pid), "utf8");
    return JSON.parse(raw) as StoredResult;
  } catch {
    return null;
  }
}

/**
 * `ay result` — two modes:
 *
 *   ay result set ['<json>' | -]   write side, run BY the agent. Keyed off the
 *                                  injected AGENT_YES_PID (or --pid N). Stores
 *                                  the envelope to ~/.agent-yes/results/<pid>.json.
 *
 *   ay result <keyword> [--wait]   read side, run by the parent. Resolves the
 *                                  agent and emits the stored envelope as JSON.
 *
 * Read-side exit codes (so an orchestrator can branch without parsing):
 *   0  envelope found and emitted
 *   1  agent stopped WITHOUT depositing one (it's done; there's no result)
 *   2  no envelope yet AND agent is still alive (pending) / --wait timed out
 */
async function cmdResult(rest: string[]): Promise<number> {
  // Write sub-verb: `ay result set ...` — keep it out of yargs so a bare JSON
  // positional with leading `-`/`{` isn't mis-parsed as flags.
  if (rest[0] === "set") {
    return await cmdResultSet(rest.slice(1));
  }

  const y = yargs(rest)
    .usage("Usage: ay result <keyword> [--wait] [--timeout Ns]")
    .option("wait", {
      type: "boolean",
      default: false,
      description:
        "Block until the agent deposits its result envelope (exit 0), or exits " +
        "without one (exit 1), or --timeout elapses (exit 2).",
    })
    .option("timeout", { type: "string", description: "Timeout for --wait (e.g. 30s, 5m)" })
    .option("interval", { type: "number", default: 2, description: "Poll interval in seconds" })
    .option("latest", { type: "boolean", default: false, description: "Use most recent match" })
    .option("cwd", { type: "string", description: "Restrict to agents under this dir" })
    .help(false)
    .version(false)
    .exitProcess(false);

  const argv = await y.parseAsync();
  const keyword = argv._[0] !== undefined ? String(argv._[0]) : undefined;
  if (!keyword) throw new Error("usage: ay result <keyword> [--wait] | ay result set '<json>'");

  const opts: CommonOpts = {
    all: true,
    active: false,
    json: false,
    latest: argv.latest,
    cwdScope: typeof argv.cwd === "string" ? path.resolve(argv.cwd) : null,
  };
  const record = await resolveOne(keyword, opts);

  const intervalMs = Math.max(500, (Number.isFinite(argv.interval) ? argv.interval : 2) * 1000);
  const timeoutMs =
    typeof argv.timeout === "string" && argv.timeout.length > 0
      ? (ms(argv.timeout) ?? Number.NaN)
      : null;
  if (timeoutMs !== null && !Number.isFinite(timeoutMs)) {
    throw new Error(`invalid --timeout value: ${argv.timeout}`);
  }

  const emitFound = (stored: StoredResult): void => {
    process.stdout.write(
      JSON.stringify({
        pid: record.pid,
        cli: record.cli,
        cwd: record.cwd,
        found: true,
        written_at: stored.written_at,
        result: stored.result,
      }) + "\n",
    );
  };
  const emitMissing = (state: string): void => {
    process.stdout.write(
      JSON.stringify({
        pid: record.pid,
        cli: record.cli,
        cwd: record.cwd,
        found: false,
        state,
      }) + "\n",
    );
  };

  const startedAt = Date.now();
  for (;;) {
    const stored = await loadStoredResult(record.pid);
    if (stored) {
      emitFound(stored);
      return 0;
    }
    const snap = await snapshotStatus(record);
    if (snap.state === "stopped") {
      // Done, but never deposited an envelope. Re-check once: the agent may have
      // written the file in the same tick it exited (race), so prefer the file.
      const last = await loadStoredResult(record.pid);
      if (last) {
        emitFound(last);
        return 0;
      }
      emitMissing("stopped");
      return 1;
    }
    if (!argv.wait) {
      emitMissing(snap.state); // pending: alive, no envelope yet
      return 2;
    }
    if (timeoutMs !== null && Date.now() - startedAt >= timeoutMs) {
      emitMissing(snap.state);
      return 2;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** `ay result set [<json> | -]` — deposit THIS agent's envelope. */
async function cmdResultSet(rest: string[]): Promise<number> {
  const y = yargs(rest)
    .usage("Usage: ay result set ['<json>' | -]")
    .option("pid", {
      type: "number",
      description: "Target pid (default: $AGENT_YES_PID — the agent's own wrapper)",
    })
    .help(false)
    .version(false)
    .exitProcess(false);
  const argv = await y.parseAsync();

  const pid = Number.isFinite(argv.pid) ? Number(argv.pid) : Number(process.env.AGENT_YES_PID);
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error(
      "ay result set: no target pid — run inside an ay-managed agent (AGENT_YES_PID is set) or pass --pid",
    );
  }

  const positional = argv._[0] !== undefined ? String(argv._[0]) : undefined;
  const raw = positional !== undefined && positional !== "-" ? positional : await readStdin();
  const result = normalizeEnvelope(raw);
  if (result === null) {
    throw new Error("ay result set: empty input — pass a JSON object, text, or pipe via stdin");
  }

  await mkdir(resultsDir(), { recursive: true });
  const stored = buildStoredResult(pid, result, Date.now());
  await writeFile(resultPath(pid), JSON.stringify(stored) + "\n");
  process.stdout.write(`result envelope written for pid ${pid}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// ay notify / ay notifyd — subagent→parent status-transition notifications.
//
// See docs/subagent-notify.md. `ay notifyd` is the detection engine (query-layer
// watcher, runtime-agnostic); `ay notify` is the parent-facing inbox reader. A
// parent typically runs ONE command in its Monitor loop:
//
//     ay notify watch --unread          # tail its inbox, ensure the daemon
//
// and gets every child's needs_input / sustained-idle / exited edge, each with a
// payload (question / tail / git head) so it can act without tailing the child.
// ---------------------------------------------------------------------------

/** Resolve the parent pid a `ay notify` invocation is draining. */
function resolveParentPid(explicit: number | undefined): number {
  if (Number.isFinite(explicit) && (explicit as number) > 0) return explicit as number;
  const self = Number(process.env.AGENT_YES_PID);
  if (Number.isFinite(self) && self > 0) return self;
  throw new Error(
    "ay notify: not running inside an agent (no AGENT_YES_PID) — pass --parent <pid>",
  );
}

function printNotifyEvents(events: NotifyEvent[], json: boolean): void {
  if (json) {
    for (const e of events) process.stdout.write(JSON.stringify(e) + "\n");
    return;
  }
  for (const e of events) {
    // Plain ASCII tag (no emoji): stays legible over the Rust/CLI path and old
    // terminals, and is easy to grep for consumers that log-parse the stream.
    const tag = `[${e.edge}]`;
    const head = `[${e.seq}] ${tag} pid ${e.child_pid} (${e.cli}) ${e.cwd}`;
    process.stdout.write(head + "\n");
    if (e.git_head) process.stdout.write(`      HEAD ${e.git_head}\n`);
    if (e.question) process.stdout.write(`      Q: ${e.question}\n`);
    if (e.tail)
      process.stdout.write(
        e.tail
          .split("\n")
          .map((l) => `      | ${l}`)
          .join("\n") + "\n",
      );
  }
}

async function cmdNotify(rest: string[]): Promise<number> {
  const verb = rest[0];
  const args = rest.slice(1);

  if (verb === "cursor") return cmdNotifyCursor(args);
  if (verb !== "read" && verb !== "watch") {
    process.stderr.write(
      "usage: ay notify <read|watch|cursor> [--parent <pid>] [--since <seq>] [--since-ts <ms>] [--unread] [--ack] [--json]\n",
    );
    return 1;
  }

  const y = yargs(args)
    .option("parent", { type: "number", description: "Parent pid whose inbox to drain (default: $AGENT_YES_PID)" })
    .option("since", { type: "number", description: "Only edges with seq greater than this" })
    .option("since-ts", { type: "number", description: "Only edges at/after this epoch-ms" })
    .option("unread", { type: "boolean", default: false, description: "Only edges past the saved cursor" })
    .option("ack", { type: "boolean", default: false, description: "Advance the cursor past what's shown (at-least-once: off by default)" })
    .option("json", { type: "boolean", default: false, description: "Emit raw NDJSON events" })
    .option("consumer", { type: "string", default: "parent", description: "Cursor identity (for multiple readers)" })
    .option("interval", { type: "number", default: 2, description: "Poll interval in seconds (watch)" })
    .option("ensure-daemon", { type: "boolean", default: true, description: "Start the notifyd singleton if not running (watch)" })
    .help(false)
    .version(false)
    .exitProcess(false);
  const argv = await y.parseAsync();

  const parent = resolveParentPid(argv.parent as number | undefined);
  const host = hostId();
  const consumer = String(argv.consumer);
  // The reader's own start time — used to reject inbox events addressed to a
  // PRIOR incarnation of this pid (pid reuse). FAIL-CLOSED: if we can't resolve
  // the parent's identity (no live registry record → started_at 0), we refuse to
  // open the notification path at all rather than fail-open and risk delivering a
  // recycled pid's inbox to an unrelated agent (or registering a 0-identity
  // watcher). "If we don't know who the parent is, don't open the path."
  const selfStartedAt = await resolveParentStartedAt(parent);
  if (selfStartedAt <= 0)
    throw new Error(
      `cannot resolve identity for pid ${parent} (no live agent record) — ` +
        `refusing to open the notification path (pass --parent for a live agent).`,
    );

  const drain = async (sinceSeqOverride?: number): Promise<number> => {
    let events = await readInbox(host, parent);
    // Parent pid-reuse guard (fail-safe): when we know our own start time, deliver
    // ONLY events whose parent_started_at EXACTLY matches it — a mismatched OR
    // missing parent identity is dropped, never fail-open-delivered to a possibly-
    // recycled pid. The daemon always stamps parent_started_at from the watcher's
    // heartbeat (the same value this reader resolves), so every legitimate event
    // matches; only truly-legacy identity-less events fall out.
    if (selfStartedAt > 0) events = events.filter((e) => e.parent_started_at === selfStartedAt);
    if (argv.unread) {
      const cursor = await getCursor(host, parent, consumer);
      events = filterUnread(events, sinceSeqOverride ?? cursor);
    } else {
      if (sinceSeqOverride !== undefined) events = filterSinceSeq(events, sinceSeqOverride);
      else if (Number.isFinite(argv.since)) events = filterSinceSeq(events, argv.since as number);
      if (Number.isFinite(argv["since-ts"])) events = filterSinceTs(events, argv["since-ts"] as number);
    }
    printNotifyEvents(events, argv.json);
    return maxSeq(events);
  };

  // Advance the cursor MONOTONICALLY — never below its current value, and never
  // regressing on an empty batch. This is what makes `watch --ack` safe across a
  // consumer restart: the high-water of what we've shown is always persisted.
  const ackTo = async (seq: number) => {
    const cur = await getCursor(host, parent, consumer);
    if (seq > cur) await setCursor(host, parent, seq, consumer);
  };

  if (verb === "read") {
    const top = await drain();
    if (argv.ack && top > 0) await ackTo(top);
    return 0;
  }

  // watch: tail -f the inbox. Default no-ack (at-least-once) so a consumer that
  // crashes mid-handling re-reads on restart; pass --ack to advance the cursor.
  const ensure = async () => {
    if (!argv["ensure-daemon"]) return;
    const { ensureDaemon } = await import("./notifyDaemon.ts");
    await ensureDaemon().catch(() => null);
  };
  // Register this parent as a live watcher BEFORE the first poll and ensure a
  // daemon exists — so a parent that watches *before* spawning any child (or
  // across a fan-out gap) still has a running, correctly-scoped daemon.
  await heartbeatWatcher(parent, selfStartedAt);
  await ensure();
  const intervalMs = Math.max(500, (Number.isFinite(argv.interval) ? argv.interval : 2) * 1000);
  // Baseline: from the cursor (unread) or the caller's --since, else from now
  // (only new edges). Track high-water seq in-memory between polls.
  let lastSeq = argv.unread
    ? await getCursor(host, parent, consumer)
    : Number.isFinite(argv.since)
      ? (argv.since as number)
      : maxSeq(await readInbox(host, parent));
  let acked = lastSeq; // high-water already persisted to the cursor
  let stop = false;
  // On signal: drop our heartbeat and exit promptly. (Even if this is missed on
  // a hard kill, the watcher's TTL makes the stale heartbeat non-live, so the
  // daemon's scope/self-exit stays correct — this is just prompt cleanup.)
  const onSig = () => {
    stop = true;
    void clearWatcher(parent).finally(() => process.exit(0));
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);
  try {
    while (!stop) {
      // Refresh our heartbeat and keep the daemon alive every tick — it self-
      // exits after a grace window with no watchers, so a long watch must renew.
      await heartbeatWatcher(parent, selfStartedAt);
      await ensure();
      const top = await drain(lastSeq);
      if (top > lastSeq) lastSeq = top;
      // Persist the high-water monotonically (only when it advanced), so a batch
      // that showed events is acked even if the NEXT poll is empty — a restarted
      // `watch --ack` then resumes past what it already delivered, not from the
      // stale cursor.
      if (argv.ack && lastSeq > acked) {
        await ackTo(lastSeq);
        acked = lastSeq;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  } finally {
    await clearWatcher(parent);
  }
  return 0;
}

/**
 * Resolve the started_at of the LIVE agent whose wrapper pid is `parent`. Returns
 * 0 (→ the caller fails closed) when there is no such record, when the matching
 * record is stale (exited / pid not alive), or when the match is ambiguous
 * (>1 live record) — so a leftover stale record can't make a recycled parent pid
 * resolve to a PRIOR incarnation's start time and fail-open the identity guard.
 */
async function resolveParentStartedAt(parent: number): Promise<number> {
  const records = await listRecords(undefined, {
    all: true,
    active: false,
    json: false,
    latest: false,
    cwdScope: null,
  }).catch(() => [] as GlobalPidRecord[]);
  const live = records.filter(
    (r) =>
      (r.wrapper_pid === parent || r.pid === parent) &&
      r.status !== "exited" &&
      isPidAlive(r.pid),
  );
  // Exactly one live match, or fail closed.
  if (live.length !== 1) return 0;
  return live[0]!.started_at ?? 0;
}

async function cmdNotifyCursor(args: string[]): Promise<number> {
  const action = args[0];
  const y = yargs(args.slice(1))
    .option("parent", { type: "number" })
    .option("consumer", { type: "string", default: "parent" })
    .help(false)
    .version(false)
    .exitProcess(false);
  const argv = await y.parseAsync();
  const parent = resolveParentPid(argv.parent as number | undefined);
  const host = hostId();
  const consumer = String(argv.consumer);
  if (action === "get") {
    process.stdout.write(String(await getCursor(host, parent, consumer)) + "\n");
    return 0;
  }
  if (action === "set") {
    const seq = Number(argv._[0]);
    if (!Number.isFinite(seq) || seq < 0) throw new Error("ay notify cursor set <seq>");
    await setCursor(host, parent, seq, consumer);
    return 0;
  }
  process.stderr.write("usage: ay notify cursor <get|set <seq>> [--parent <pid>]\n");
  return 1;
}

async function cmdNotifyd(rest: string[]): Promise<number> {
  const sub = rest[0] ?? "status";
  const daemon = await import("./notifyDaemon.ts");
  switch (sub) {
    case "run":
      return daemon.runDaemon();
    case "once":
      return daemon.runDaemon({ once: true });
    case "start": {
      const pid = await daemon.ensureDaemon();
      process.stdout.write(pid ? `notifyd running (pid ${pid})\n` : "notifyd: failed to start\n");
      return pid ? 0 : 1;
    }
    case "status": {
      const pid = await daemon.daemonStatus();
      process.stdout.write(pid ? `notifyd running (pid ${pid})\n` : "notifyd: not running\n");
      return pid ? 0 : 1;
    }
    case "stop": {
      // Cooperative, non-destructive stop: remove the daemon's lock and let it
      // exit itself on the next tick — never SIGTERM a pid that may have been
      // recycled onto an unrelated process.
      const pid = await daemon.requestDaemonStop();
      process.stdout.write(
        pid ? `notifyd: stop requested (pid ${pid} will exit shortly)\n` : "notifyd: not running\n",
      );
      return 0;
    }
    default:
      process.stderr.write("usage: ay notifyd <run|once|start|status|stop>\n");
      return 1;
  }
}
