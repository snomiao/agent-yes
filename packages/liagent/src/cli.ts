#!/usr/bin/env bun
/**
 * liagent — the agent's side of the user ⇄ agent chat (src/hub.ts).
 *
 *   liagent pair   [hub] [--eval] [--label "…"]
 *       Ask the user to approve this agent: prints a short code, which the
 *       box shows too. Chat (the default) lasts 30 days on all of the user's
 *       pages; --eval asks to run code (and chat) for 8 hours on the pages
 *       the user ticks. Either way the grant token is saved, so later
 *       commands resume it without asking.
 *
 *   liagent listen [hub] [--to <agent>] [--out <file>] [--label "…"]
 *       Hold the chat. Each new message from the user (or a friend) is one
 *       JSON line on stdout {type:"chat", id, from, label, text, at, thread?},
 *       and so is each {type:"page-changed", label, thread, at} when one of
 *       the user's pages navigates (all also appended to --out). With --to,
 *       each message is also delivered into that agent-yes agent with
 *       `ay send`, with the reply command in it, and while the agent works
 *       (its `ay ls` status is "active") the box shows a spinner. It resumes
 *       the saved grant and reconnects on network drops (backing off from 1 s
 *       to a minute) without ever asking the user again; see "Pairing".
 *
 *   liagent say    [hub] "text" | -   [--to <email|user id>]
 *       Reply in the box (the user's thread, or a friend's), then exit.
 *
 *   liagent busy   [hub] [--to <email|user id>] [--every <seconds>]
 *       One heartbeat: the box shows a spinner for 12 s, or until you reply.
 *       With --every (e.g. 4, run it in the background), it keeps beating
 *       until your next reply in that thread, and then exits (30 min at most).
 *
 *   liagent eval   [hub] [--target <text>] '<code>' | -
 *       Run code on the pages the user allowed (a hub with eval only),
 *       resuming the saved eval grant, and print each page's result.
 *
 * Pairing prompts the user, so it is rationed:
 *   - A command resumes the saved grant for its scope (x-liagent-token).
 *   - It pairs at most once per process, and never from a reconnect loop.
 *   - A saved grant the hub rejects (4498) is forgotten, and the command
 *     pairs once; if that fails too, it stops (listen stays idle).
 *   - A pairing that fails is never retried: denied, expired (4408),
 *     another request waiting (4429), no page open (4404), or no answer.
 *   - --no-pair (any command): only ever resume; never ask.
 *
 * [hub] is the hub's page-socket URL, e.g. https://dev.example.com/api/chat
 * (its agent socket is <hub>/control). Default: $LIAGENT_HUB. Grants are kept
 * in ~/.config/liagent/grants.json (mode 600; $LIAGENT_GRANTS overrides), one
 * per hub and scope. "End" in the box revokes a grant; the CLI then forgets it.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { deliveryText } from "./deliver.ts";
import { type Scope, grantStore, spillTo } from "./grants.ts";
import { PENDING_MS, type ChatMessage } from "./protocol.ts";

type Msg = Record<string, unknown> & { type?: string };

const GRANTS = process.env.LIAGENT_GRANTS ?? join(homedir(), ".config", "liagent", "grants.json");
const RESULT_MS = 20_000;
/** How often `listen --to` checks the agent's status and beats (pages time a beat out after 12 s). */
const BEAT_MS = 5_000;

function usage(code = 0): never {
  const src = readFileSync(new URL(import.meta.url).pathname, "utf8");
  (code ? console.error : console.log)(src.slice(src.indexOf("/**"), src.indexOf("*/") + 2));
  process.exit(code);
}

const args = process.argv.slice(2);
const cmd = args.shift();
if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") usage();
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const labelFlag = flag("--label");
const label = labelFlag ?? `agent on ${hostname()}`;

/** The hub: the first argument if it is a URL, else $LIAGENT_HUB. */
function takeHub(): string {
  if (args[0] && /^(https?|wss?):\/\//.test(args[0])) return args.shift()!.replace(/\/+$/, "");
  const env = process.env.LIAGENT_HUB?.replace(/\/+$/, "");
  if (!env) {
    console.error("liagent: no hub — pass its URL or set LIAGENT_HUB");
    process.exit(2);
  }
  return env;
}

// ---- grants -----------------------------------------------------------------

const grants = grantStore(GRANTS);
const loadToken = grants.load;
const saveToken = grants.save;
const forgetToken = grants.forget;

// ---- sockets ----------------------------------------------------------------

function controlUrl(hub: string, extra: Record<string, string> = {}) {
  const u = new URL(`${hub}/control`);
  if (u.protocol === "http:") u.protocol = "ws:";
  if (u.protocol === "https:") u.protocol = "wss:";
  // Resuming a grant without --label keeps the label it was approved under.
  const l = extra.token ? (labelFlag ?? "") : label;
  if (l) u.searchParams.set("label", l);
  for (const [k, v] of Object.entries(extra)) if (k !== "token") u.searchParams.set(k, v);
  return u.toString();
}

/**
 * Bun's WebSocket takes headers, so the grant goes in one, never in the URL.
 * Without a grant, the knock says what it asks for: chat (30 days) or eval (8 hours).
 */
function open(hub: string, scope: Scope, token?: string): WebSocket {
  return token
    ? new WebSocket(controlUrl(hub, { token }), {
        headers: { "x-liagent-token": token },
      } as unknown as string[])
    : new WebSocket(controlUrl(hub, { scope }));
}

/**
 * Why a connection attempt failed. `code` is the close code (or 0); `fatal`
 * means asking again would only prompt the user again: stop instead.
 */
class ConnectError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly fatal: boolean,
  ) {
    super(message);
  }
}

/** --no-pair: only ever resume a saved grant; never ask the user. */
const noPair = args.includes("--no-pair");
if (noPair) args.splice(args.indexOf("--no-pair"), 1);
/** Pairing prompts the user, so a process asks at most once — never from a reconnect loop. */
let pairedOnce = false;

/** One socket: resume with `token`, or knock without one. Resolves once approved. */
function attempt(hub: string, scope: Scope, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = open(hub, scope, token);
    let settled = false;
    let reason = "";
    const done = (err?: ConnectError) => {
      if (settled) return;
      settled = true;
      clearTimeout(give);
      if (err) {
        ws.close();
        reject(err);
      } else resolve(ws);
    };
    const give = setTimeout(
      () => done(new ConnectError("no answer in the box within 2 minutes", 0, true)),
      PENDING_MS + 5_000,
    );
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Msg;
      if (m.type === "pending")
        console.error(
          `Pairing as "${label}" (${scope === "eval" ? "run code and chat, 8 hours" : "chat, 30 days"}). In the box, allow code  ${m.code}`,
        );
      else if (m.type === "approved") {
        // Every approval of the user's own carries a token (chat 30 days, eval 8 hours).
        if (typeof m.token === "string") saveToken(hub, scope, m.token, Number(m.until));
        if (!m.resumed)
          console.error(
            `Approved (${m.scope}${m.pages === "all" ? ", all pages" : Array.isArray(m.pages) ? `, ${m.pages.length} page(s)` : ""}) until ${new Date(Number(m.until)).toLocaleString()}.`,
          );
        ws.onmessage = null;
        ws.onclose = null;
        done();
      } else if (m.type === "error" || m.type === "denied" || m.type === "expired")
        reason = String(m.error ?? m.type);
    };
    ws.onclose = (e) =>
      done(
        new ConnectError(
          reason || `socket closed (${e.code}${e.reason ? ` ${e.reason}` : ""})`,
          e.code,
          false,
        ),
      );
  });
}

/**
 * An approved socket for `scope`: resume the saved grant, or — once per
 * process, and never with --no-pair — pair, which prompts the user. A
 * rejected token (4498) is forgotten and leads to that one pairing. Any
 * failure of the pairing itself (denied, 4408 expired, 4429 another request
 * waiting, 4404 no page open, no answer) is fatal: it is not retried.
 * A network failure while resuming is not fatal: the caller retries later.
 */
async function connect(hub: string, scope: Scope = "chat"): Promise<WebSocket> {
  const token = loadToken(hub, scope);
  if (token) {
    try {
      return await attempt(hub, scope, token);
    } catch (e) {
      const err = e as ConnectError;
      if (err.code !== 4498) throw err;
      forgetToken(hub, scope);
      console.error(`liagent: the saved ${scope} grant is no longer valid (${err.message}).`);
    }
  }
  if (noPair) throw new ConnectError(`no valid ${scope} grant, and --no-pair was given`, 0, true);
  if (pairedOnce)
    throw new ConnectError(
      "already asked the user once in this process; not asking again",
      0,
      true,
    );
  pairedOnce = true;
  try {
    return await attempt(hub, scope);
  } catch (e) {
    const err = e as ConnectError;
    throw new ConnectError(`pairing failed: ${err.message}`, err.code, true);
  }
}

/** One-shot commands: an approved socket, or the error and exit 1. */
async function connectOrExit(hub: string, scope: Scope = "chat"): Promise<WebSocket> {
  try {
    return await connect(hub, scope);
  } catch (e) {
    console.error(`liagent: ${(e as Error).message}`);
    process.exit(1);
  }
}

/** Send one message and wait for the reply of `type` (or an error). */
function request(ws: WebSocket, msg: unknown, type: string, ms = RESULT_MS): Promise<Msg> {
  return new Promise((resolve, reject) => {
    const give = setTimeout(() => reject(new Error(`no ${type} within ${ms / 1000}s`)), ms);
    const on = (e: MessageEvent) => {
      const m = JSON.parse(String(e.data)) as Msg;
      if (m.type === type) {
        clearTimeout(give);
        ws.removeEventListener("message", on);
        resolve(m);
      } else if (m.type === "error" || m.type === "revoked" || m.type === "expired") {
        clearTimeout(give);
        ws.removeEventListener("message", on);
        reject(new Error(String(m.error ?? m.type)));
      }
    };
    ws.addEventListener("message", on);
    ws.send(JSON.stringify(msg));
  });
}

async function readText(): Promise<string> {
  const rest = args.join(" ");
  if (rest !== "-") return rest;
  return (await new Response(Bun.stdin.stream()).text()).trim();
}

// ---- agent-yes bridge ----------------------------------------------------------

/** The agent-yes status of `to` (pid, agent id or its prefix), or undefined. */
function agentStatus(to: string): string | undefined {
  const r = Bun.spawnSync(["ay", "ls", "--json"], { stderr: "ignore" });
  if (!r.success) return undefined;
  try {
    const list = JSON.parse(r.stdout.toString()) as {
      pid: number;
      agent_id?: string;
      status?: string;
    }[];
    const hit = list.find((a) => String(a.pid) === to || (a.agent_id && a.agent_id.startsWith(to)));
    return hit?.status;
  } catch {
    return undefined;
  }
}

const INBOX = join(dirname(GRANTS), "inbox");

const spillToInbox = (id: string, text: string) => spillTo(INBOX, id, text);

/**
 * Deliver one message into an agent-yes agent. --force: the owner named the
 * agent with --to, and an agent idle for a minute is the normal case here.
 * --raw: our own header carries the reply route. Exit 4 (queued for the
 * agent's input box) counts as delivered; anything else is retried.
 */
function deliver(to: string, text: string): boolean {
  const r = Bun.spawnSync(["ay", "send", to, text, "--force", "--raw"], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (r.exitCode === 0 || r.exitCode === 4) return true;
  console.error(`liagent: ay send ${to} failed (${r.exitCode}): ${r.stderr.toString().trim()}`);
  return false;
}

// ---- commands ----------------------------------------------------------------

/** Stay up without reconnecting or prompting: a supervisor restarting us would only ask again. */
function idle(): Promise<never> {
  console.error(
    "liagent: idle. Fix the grant (or restart with `liagent pair`) and run listen again.",
  );
  // A pending promise alone does not keep the process up: a timer does.
  setInterval(() => {}, 1 << 30);
  return new Promise<never>(() => {});
}

async function cmdListen(hub: string) {
  const to = flag("--to");
  const out = flag("--out");
  let backoff = 1_000;
  let beat: ReturnType<typeof setInterval> | undefined;
  /** Messages `ay send` refused (agent unreachable…), retried on every beat, in order. */
  const undelivered: string[] = [];
  const flush = () => {
    while (to && undelivered.length && deliver(to, undelivered[0]!)) undelivered.shift();
  };
  for (;;) {
    let ws: WebSocket;
    try {
      ws = await connect(hub);
    } catch (e) {
      const err = e as ConnectError;
      console.error(`liagent: ${err.message}`);
      if (err.fatal) return idle();
      await Bun.sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
      continue;
    }
    backoff = 1_000;
    console.error(`Listening on ${hub}${to ? `, delivering to ${to}` : ""}.`);
    // While the agent works, the user's box shows a spinner: one beat every
    // BEAT_MS while its agent-yes status is "active"; the reply ends it.
    if (to)
      beat = setInterval(() => {
        flush();
        if (agentStatus(to) === "active") ws.send(JSON.stringify({ type: "busy" }));
      }, BEAT_MS);
    const closed = new Promise<number>((resolve) => {
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as Msg;
        if (m.type === "chat") {
          const c = m.message as ChatMessage & { email?: string };
          if (c.from === "agent") return;
          const line = JSON.stringify({ type: "chat", ...c });
          console.log(line);
          if (out) appendFileSync(out, `${line}\n`);
          if (to) {
            undelivered.push(deliveryText(hub, c, spillToInbox));
            flush();
            ws.send(
              JSON.stringify(
                c.from === "friend" ? { type: "busy", to: c.thread } : { type: "busy" },
              ),
            );
          }
        } else if (m.type === "friend-new" || m.type === "page-changed") {
          const line = JSON.stringify(m);
          console.log(line);
          if (out) appendFileSync(out, `${line}\n`);
        } else if (m.type === "error") console.error(`liagent: ${m.error}`);
        else if (m.type === "revoked") {
          console.error("liagent: the user ended this session.");
          forgetToken(hub, "chat");
          process.exit(0);
        }
      };
      ws.onclose = (e) => resolve(e.code);
    });
    const code = await closed;
    clearInterval(beat);
    if (code === 4401) {
      forgetToken(hub, "chat");
      console.error("liagent: the user ended this session.");
      process.exit(0);
    }
    // 4409 (its pages were away): the grant stays; the reconnect below resumes it.
    // 4498 (the grant lapsed): the next connect forgets it and pairs at most once.
    console.error(`liagent: socket closed (${code}); reconnecting in ${backoff / 1000}s`);
    await Bun.sleep(backoff);
    backoff = Math.min(backoff * 2, 60_000);
  }
}

async function main() {
  const hub = takeHub();
  if (cmd === "pair") {
    const scope: Scope = args.includes("--eval") ? "eval" : "chat";
    const ws = await connectOrExit(hub, scope);
    ws.close();
    return;
  }
  if (cmd === "listen") return cmdListen(hub);
  if (cmd === "say") {
    const to = flag("--to");
    const text = await readText();
    if (!text) usage(2);
    const ws = await connectOrExit(hub);
    const r = await request(ws, to ? { type: "say", text, to } : { type: "say", text }, "said");
    console.error(`said ${r.id}`);
    ws.close();
    return;
  }
  if (cmd === "busy") {
    const to = flag("--to");
    const every = Number(flag("--every") ?? 0);
    const ws = await connectOrExit(hub);
    const beat = () => ws.send(JSON.stringify(to ? { type: "busy", to } : { type: "busy" }));
    beat();
    if (every > 0) {
      // An approved socket hears every message: the agent's next reply in
      // this thread ends the beating (the hub resolves --to to a thread, so
      // any agent reply after a friend's beat counts too).
      const timer = setInterval(beat, Math.max(1, every) * 1000);
      await new Promise<void>((resolve) => {
        const stop = setTimeout(resolve, 30 * 60_000);
        ws.onmessage = (e) => {
          const m = JSON.parse(String(e.data)) as Msg;
          if (m.type === "chat" && (m.message as ChatMessage).from === "agent") {
            clearTimeout(stop);
            resolve();
          }
        };
        ws.onclose = () => resolve();
      });
      clearInterval(timer);
    }
    await Bun.sleep(200);
    ws.close();
    return;
  }
  if (cmd === "eval") {
    const target = flag("--target");
    const code = await readText();
    if (!code) usage(2);
    const ws = await connectOrExit(hub, "eval");
    const results: Msg[] = [];
    await new Promise<void>((resolve, reject) => {
      let id = "";
      let expected = Infinity;
      const give = setTimeout(resolve, RESULT_MS);
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as Msg;
        if (m.type === "sent") {
          id = String(m.id);
          expected = Number(m.delivered);
          console.error(`eval ${id}: delivered to ${expected} page(s)`);
        } else if (m.type === "result" && m.id === id) results.push(m);
        else if (m.type === "error") {
          clearTimeout(give);
          return reject(new Error(String(m.error)));
        }
        if (results.length >= expected) {
          clearTimeout(give);
          resolve();
        }
      };
      ws.send(JSON.stringify(target ? { type: "eval", code, target } : { type: "eval", code }));
    });
    console.log(JSON.stringify(results, null, 2));
    ws.close();
    return;
  }
  usage(2);
}

main().catch((e) => {
  console.error(`liagent: ${(e as Error).message}`);
  process.exit(1);
});
