/**
 * `ay ch` — channels: local-first, end-to-end threads where AI agents and humans
 * talk on a topic. No server ever stores a message; every participant keeps a
 * full replica as an append-only CRDT log, cwd-scoped like the rest of
 * agent-yes's per-project state:
 *
 *   ay ch mk <topic> [--sighost H] [--name N] [--role agent|human] [--salt HEX]
 *   ay ch join <link> [--as <topic>] [--name N] [--role R]
 *   ay ch ls [--json]
 *   ay ch rm <topic>
 *   ay ch send <topic> <text…> [--name N] [--role R]
 *   ay ch read <topic> [-n N] [--json]
 *   ay ch head <topic> [-n N]
 *   ay ch tail <topic> [-n N] [-f]
 *
 * Phase 1 is local-only (the log, the CRDT, the verbs). Live delivery over the
 * WebRTC mesh (`--once`, real `tail -f` across peers, `pipe`) arrives with the
 * serve daemon in Phase 2; the on-disk format and identity model here are the
 * foundation both share.
 *
 * The channels core (ts/channels/) is isomorphic and reused verbatim by the
 * browser lib; this file is the Node CLI shell over it, mirroring ts/ws.ts.
 */

import { randomBytes } from "crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import {
  deriveChannelId,
  deriveRoom,
  formatChannelLink,
  formatChannelWebLink,
  hlcSend,
  isChannelLink,
  makeOp,
  maxHlc,
  parseChannelLink,
  renderThread,
  type Message,
  type Role,
} from "./channels/index.ts";
import { appendOps, channelFilePath, readOps } from "./channels/store.node.ts";

const REG_SCHEMA = "ay-ch/v1";

interface ChannelRegEntry {
  topic: string;
  channelId: string;
  room: string;
  sighost: string;
  /** Shared secret S (64-hex); the registry file is chmod 0600. */
  s: string;
  /** Stable per-participant id — the HLC node + author identity. */
  author: string;
  name: string;
  role: Role;
  createdAt: number;
}

interface ChannelRegistry {
  schema: string;
  channels: Record<string, ChannelRegEntry>;
}

// --- identity defaults ------------------------------------------------------

/** An agent (AGENT_YES_PID set) defaults to role "agent"; a human shell to "human". */
export function defaultRole(): Role {
  return process.env.AGENT_YES_PID ? "agent" : "human";
}

/** Default display name: $AY_CH_NAME, else the OS username, else "anon". */
export function defaultName(): string {
  if (process.env.AY_CH_NAME) return process.env.AY_CH_NAME;
  try {
    return os.userInfo().username || "anon";
  } catch {
    return "anon";
  }
}

function validRole(v: string | boolean | undefined): Role {
  if (v === "agent" || v === "human") return v;
  throw new Error(`--role must be "agent" or "human"`);
}

// --- registry IO ------------------------------------------------------------

function registryPath(cwd: string): string {
  return path.join(cwd, ".agent-yes", "channels.json");
}

export async function readRegistry(cwd: string): Promise<ChannelRegistry> {
  try {
    const reg = JSON.parse(await readFile(registryPath(cwd), "utf-8")) as ChannelRegistry;
    if (reg && typeof reg === "object" && reg.channels) return reg;
  } catch {
    /* missing/corrupt → empty */
  }
  return { schema: REG_SCHEMA, channels: {} };
}

async function writeRegistry(cwd: string, reg: ChannelRegistry): Promise<void> {
  const file = registryPath(cwd);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(reg, null, 2) + "\n");
  await chmod(file, 0o600).catch(() => {}); // best-effort (no-op on Windows)
}

/**
 * Resolve a `<topic|link>` operand. A registered topic yields its full entry; a
 * bare invite link yields just its channelId (read-only — sending needs an
 * identity, i.e. `ay ch join` first). Anything else is an error.
 */
export async function resolveChannel(
  reg: ChannelRegistry,
  arg: string,
): Promise<{ channelId: string; entry: ChannelRegEntry | null }> {
  const entry = reg.channels[arg];
  if (entry) return { channelId: entry.channelId, entry };
  if (isChannelLink(arg)) {
    const link = parseChannelLink(arg);
    if (link) return { channelId: await deriveChannelId(link.s), entry: null };
  }
  throw new Error(`no channel "${arg}" — see 'ay ch ls', or 'ay ch join <link>'`);
}

// --- display ----------------------------------------------------------------

/** One rendered thread line: `HH:MM:SS  name(a): text  👍2`. Pure, for tests. */
export function formatMessage(m: Message): string {
  const t = new Date(m.ms).toISOString().slice(11, 19);
  const who = `${m.name}(${m.role[0]})`;
  const text = m.deleted ? "(deleted)" : m.text;
  const react = m.reactions.length
    ? "  " + m.reactions.map((r) => `${r.emoji}${r.by.length > 1 ? r.by.length : ""}`).join(" ")
    : "";
  return `${t}  ${who}: ${text}${react}`;
}

// --- flag parsing (tiny, mirrors ws.ts) -------------------------------------

function parseFlags(
  args: string[],
  known: Record<string, "bool" | "value">,
): { flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("-") || a === "-") {
      positional.push(a);
      continue;
    }
    // support -n as an alias for --limit
    const isShortN = a === "-n";
    const eq = a.indexOf("=");
    const name = isShortN
      ? "limit"
      : eq === -1
        ? a.replace(/^--?/, "")
        : a.slice(a.startsWith("--") ? 2 : 1, eq);
    const kind = known[name];
    if (!kind) throw new Error(`unknown flag ${a}`);
    if (kind === "bool") {
      if (eq !== -1) throw new Error(`--${name} takes no value`);
      flags[name] = true;
    } else {
      const v = eq !== -1 ? a.slice(eq + 1) : args[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      flags[name] = v;
    }
  }
  return { flags, positional };
}

function limitOf(flags: Record<string, string | boolean>): number | undefined {
  if (flags.limit === undefined) return undefined;
  const n = Number(flags.limit);
  if (!Number.isInteger(n) || n < 0) throw new Error(`-n/--limit must be a non-negative integer`);
  return n;
}

// --- verbs ------------------------------------------------------------------

async function cmdChMk(cwd: string, args: string[]): Promise<number> {
  const { flags, positional } = parseFlags(args, {
    sighost: "value",
    name: "value",
    role: "value",
    salt: "value",
  });
  const topic = positional[0];
  if (!topic || positional.length > 1)
    throw new Error("usage: ay ch mk <topic> [--sighost H] [--name N] [--role R] [--salt HEX]");
  const reg = await readRegistry(cwd);
  if (reg.channels[topic])
    throw new Error(`channel "${topic}" already exists (ay ch rm ${topic} to replace)`);

  const s = typeof flags.salt === "string" ? flags.salt : randomBytes(32).toString("hex");
  const [channelId, room] = await Promise.all([deriveChannelId(s), deriveRoom(s)]);
  const sighost = typeof flags.sighost === "string" ? flags.sighost : undefined;
  const entry: ChannelRegEntry = {
    topic,
    channelId,
    room,
    sighost: sighost ?? "s.agent-yes.com",
    s,
    author: randomBytes(8).toString("hex"),
    name: typeof flags.name === "string" ? flags.name : defaultName(),
    role: flags.role ? validRole(flags.role) : defaultRole(),
    createdAt: Date.now(),
  };
  reg.channels[topic] = entry;
  await writeRegistry(cwd, reg);

  const link = formatChannelLink({ sighost: entry.sighost, room, s });
  process.stdout.write(
    `created channel "${topic}"  (${entry.name}, ${entry.role})\n` +
      `  invite (CLI):     ${link}\n` +
      `  invite (browser): ${formatChannelWebLink({ sighost: entry.sighost, room, s })}\n` +
      `\n  share the invite; others join with:  ay ch join '${link}'\n`,
  );
  return 0;
}

async function cmdChJoin(cwd: string, args: string[]): Promise<number> {
  const { flags, positional } = parseFlags(args, { as: "value", name: "value", role: "value" });
  const linkStr = positional[0];
  if (!linkStr || positional.length > 1)
    throw new Error("usage: ay ch join <link> [--as <topic>] [--name N] [--role R]");
  const link = parseChannelLink(linkStr);
  if (!link) throw new Error(`not a channel invite link: ${linkStr}`);

  const channelId = await deriveChannelId(link.s);
  const topic = typeof flags.as === "string" ? flags.as : `ch-${link.room.slice(0, 10)}`;
  const reg = await readRegistry(cwd);
  const existing = reg.channels[topic];
  if (existing && existing.channelId !== channelId)
    throw new Error(`topic "${topic}" is already bound to a different channel — pick another --as`);

  const entry: ChannelRegEntry = existing ?? {
    topic,
    channelId,
    room: link.room,
    sighost: link.sighost,
    s: link.s,
    author: randomBytes(8).toString("hex"),
    name: typeof flags.name === "string" ? flags.name : defaultName(),
    role: flags.role ? validRole(flags.role) : defaultRole(),
    createdAt: Date.now(),
  };
  if (typeof flags.name === "string") entry.name = flags.name;
  if (flags.role) entry.role = validRole(flags.role);
  reg.channels[topic] = entry;
  await writeRegistry(cwd, reg);
  process.stdout.write(`joined channel "${topic}"  (${entry.name}, ${entry.role})\n`);
  return 0;
}

async function cmdChLs(cwd: string, args: string[]): Promise<number> {
  const { flags, positional } = parseFlags(args, { json: "bool" });
  if (positional.length) throw new Error("ay ch ls takes no positional args");
  const reg = await readRegistry(cwd);
  const topics = Object.keys(reg.channels).sort();

  const rows = await Promise.all(
    topics.map(async (topic) => {
      const e = reg.channels[topic]!;
      const ops = await readOps(cwd, e.channelId);
      const msgs = renderThread(ops);
      const last = msgs.length ? msgs[msgs.length - 1]! : null;
      return {
        topic,
        channelId: e.channelId,
        name: e.name,
        role: e.role,
        messages: msgs.length,
        lastMs: last ? last.ms : null,
      };
    }),
  );

  if (flags.json) {
    process.stdout.write(JSON.stringify({ schema: REG_SCHEMA, channels: rows }, null, 2) + "\n");
    return 0;
  }
  if (rows.length === 0) {
    process.stderr.write(`no channels in ${cwd} — 'ay ch mk <topic>' or 'ay ch join <link>'\n`);
    return 0;
  }
  const w = Math.max(5, ...rows.map((r) => r.topic.length));
  process.stdout.write(`${"TOPIC".padEnd(w)}  ${"MSGS".padStart(5)}  LAST\n`);
  for (const r of rows) {
    const last = r.lastMs ? new Date(r.lastMs).toISOString().slice(0, 19).replace("T", " ") : "-";
    process.stdout.write(`${r.topic.padEnd(w)}  ${String(r.messages).padStart(5)}  ${last}\n`);
  }
  return 0;
}

async function cmdChRm(cwd: string, args: string[]): Promise<number> {
  const { positional } = parseFlags(args, {});
  const topic = positional[0];
  if (!topic || positional.length > 1) throw new Error("usage: ay ch rm <topic>");
  const reg = await readRegistry(cwd);
  const entry = reg.channels[topic];
  if (!entry) throw new Error(`no channel "${topic}"`);
  delete reg.channels[topic];
  await writeRegistry(cwd, reg);
  await rm(channelFilePath(cwd, entry.channelId), { force: true });
  process.stdout.write(`removed channel "${topic}" (local replica deleted; peers unaffected)\n`);
  return 0;
}

async function cmdChSend(cwd: string, args: string[]): Promise<number> {
  const { flags, positional } = parseFlags(args, { name: "value", role: "value" });
  const topic = positional[0];
  const text = positional.slice(1).join(" ");
  if (!topic || !text) throw new Error("usage: ay ch send <topic> <text…>");
  const reg = await readRegistry(cwd);
  const { channelId, entry } = await resolveChannel(reg, topic);
  if (!entry) throw new Error(`join "${topic}" before sending: ay ch join <link>`);

  const ops = await readOps(cwd, channelId);
  const hlc = hlcSend(maxHlc(ops), Date.now(), entry.author);
  const op = makeOp({
    author: entry.author,
    name: typeof flags.name === "string" ? flags.name : entry.name,
    role: flags.role ? validRole(flags.role) : entry.role,
    hlc,
    kind: "msg",
    body: text,
  });
  await appendOps(cwd, channelId, [op]);
  // Phase 2: also hand `op` to the serve daemon to broadcast over the mesh.
  return 0;
}

async function readAndRender(cwd: string, channelId: string): Promise<Message[]> {
  return renderThread(await readOps(cwd, channelId));
}

async function cmdChRead(
  cwd: string,
  args: string[],
  mode: "read" | "head" | "tail",
): Promise<number> {
  const { flags, positional } = parseFlags(args, {
    limit: "value",
    json: "bool",
    follow: "bool",
    f: "bool",
  });
  const topic = positional[0];
  if (!topic || positional.length > 1) throw new Error(`usage: ay ch ${mode} <topic> [-n N]`);
  const reg = await readRegistry(cwd);
  const { channelId } = await resolveChannel(reg, topic);

  const n = limitOf(flags);
  let msgs = await readAndRender(cwd, channelId);
  if (mode === "head") msgs = msgs.slice(0, n ?? 10);
  else if (mode === "tail") msgs = msgs.slice(-(n ?? 96));
  else if (n !== undefined) msgs = msgs.slice(-n);

  if (flags.json) {
    process.stdout.write(JSON.stringify(msgs, null, 2) + "\n");
  } else {
    for (const m of msgs) process.stdout.write(formatMessage(m) + "\n");
  }

  if (mode === "tail" && (flags.follow || flags.f)) {
    await followChannel(cwd, channelId, new Set(msgs.map((m) => m.id)));
  }
  return 0;
}

/**
 * Follow a channel, printing messages as they appear. Phase 1 polls the local
 * replica (fs.watch is unreliable in long-lived daemons — see the fswatch-dies
 * note), so it surfaces same-cwd appends; Phase 2's daemon feeds it live peer
 * traffic. Runs until SIGINT.
 */
function followChannel(cwd: string, channelId: string, seen: Set<string>): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setInterval(async () => {
      const msgs = await readAndRender(cwd, channelId);
      for (const m of msgs) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        process.stdout.write(formatMessage(m) + "\n");
      }
    }, 500);
    const stop = () => {
      clearInterval(timer);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function chHelp(): number {
  process.stdout.write(
    `ay ch - local-first E2E channels for AI ↔ humans (per-cwd, no server storage)\n` +
      `\n` +
      `  ay ch mk <topic> [--name N] [--role R]   create a channel, print an invite link\n` +
      `  ay ch join <link> [--as <topic>]         join a channel from an invite link\n` +
      `  ay ch ls [--json]                        list channels in this project (+message counts)\n` +
      `  ay ch rm <topic>                         delete the local replica (peers unaffected)\n` +
      `  ay ch send <topic> <text…>               post a message\n` +
      `  ay ch read <topic> [-n N] [--json]       print the thread (last N)\n` +
      `  ay ch head <topic> [-n N]                first N messages\n` +
      `  ay ch tail <topic> [-n N] [-f]           last N (96), -f to follow\n` +
      `\n` +
      `  identity: --name defaults to $AY_CH_NAME/OS user; --role to agent (in an agent) or human\n` +
      `  storage:  <cwd>/.agent-yes/ch-<id>.jsonl  (a full CRDT replica; cwd-scoped)\n`,
  );
  return 0;
}

/** `ay ch <sub> …` dispatcher (called from runSubcommand). */
export async function cmdCh(args: string[]): Promise<number> {
  const cwd = process.cwd();
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "mk":
    case "new":
    case "create":
      return cmdChMk(cwd, rest);
    case "join":
      return cmdChJoin(cwd, rest);
    case "ls":
    case "list":
      return cmdChLs(cwd, rest);
    case "rm":
    case "remove":
      return cmdChRm(cwd, rest);
    case "send":
      return cmdChSend(cwd, rest);
    case "read":
      return cmdChRead(cwd, rest, "read");
    case "head":
      return cmdChRead(cwd, rest, "head");
    case "tail":
      return cmdChRead(cwd, rest, "tail");
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return chHelp();
    default:
      process.stderr.write(`ay ch: unknown subcommand "${sub}"\n\n`);
      chHelp();
      return 1;
  }
}
