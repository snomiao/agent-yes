#!/usr/bin/env bun
/**
 * liagent — the agent's side of the user ⇄ agent chat (src/hub.ts).
 *
 *   liagent pair   [hub] [--label "…"]
 *       Ask the user to let this agent chat: prints a short code, which the
 *       box shows too. The user allows it for some of their open pages (the
 *       one they answer on, by default) or all of them; that grant lasts 30
 *       days and is saved, so the commands below reconnect without asking.
 *
 *   liagent listen [hub] [--to <agent>] [--out <file>] [--label "…"]
 *       Hold the chat. Each new message from the user (or a friend) is one
 *       JSON line on stdout {type:"chat", id, from, label, text, at, thread?},
 *       and so is each {type:"page-changed", label, thread, at} when one of
 *       the user's pages navigates (all also appended to --out). With --to,
 *       each message is also delivered into that agent-yes agent with
 *       `ay send`, with the reply command in it, and while the agent works
 *       (its `ay ls` status is "active") the box shows a spinner. Pairs first
 *       if there is no grant, and pairs again if every page of the grant has
 *       closed. Reconnects on close, backing off from 1 s to a minute.
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
 *       Run code on the user's open pages (a hub with eval only): asks for
 *       an hour of eval for this command — the user allows it on the pages
 *       it may touch — and prints each page's result.
 *
 * [hub] is the hub's page-socket URL, e.g. https://dev.example.com/api/chat
 * (its agent socket is <hub>/control). Default: $LIAGENT_HUB. Grants are kept
 * in ~/.config/liagent/grants.json (mode 600; $LIAGENT_GRANTS overrides), one
 * per hub. "End" in the box revokes a grant; the CLI then forgets it.
 */
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { deliveryText } from "./deliver.ts";
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

type Grants = Record<string, { token: string; until: string }>;
const readGrants = (): Grants => {
  try {
    return JSON.parse(readFileSync(GRANTS, "utf8")) as Grants;
  } catch {
    return {};
  }
};
const loadToken = (hub: string) => readGrants()[hub]?.token;
const saveToken = (hub: string, token: string, until: number) => {
  mkdirSync(dirname(GRANTS), { recursive: true });
  writeFileSync(
    GRANTS,
    JSON.stringify(
      { ...readGrants(), [hub]: { token, until: new Date(until).toISOString() } },
      null,
      2,
    ),
  );
  chmodSync(GRANTS, 0o600);
};
const forgetToken = (hub: string) => {
  const g = readGrants();
  if (!(hub in g)) return;
  delete g[hub];
  writeFileSync(GRANTS, JSON.stringify(g, null, 2));
};

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
 * Without a grant, the knock says what it asks for: chat (30 days) or eval (1 hour).
 */
function open(hub: string, scope: "chat" | "eval", token?: string): WebSocket {
  return token
    ? new WebSocket(controlUrl(hub, { token }), {
        headers: { "x-liagent-token": token },
      } as unknown as string[])
    : new WebSocket(controlUrl(hub, { scope }));
}

/**
 * An approved socket: resume the saved grant, or pair (printing the code).
 * Eval always pairs afresh: it is an hour on one socket, never a saved grant.
 */
function connect(
  hub: string,
  opts: { scope?: "chat" | "eval"; fresh?: boolean } = {},
): Promise<WebSocket> {
  const scope = opts.scope ?? "chat";
  const token = opts.fresh || scope === "eval" ? undefined : loadToken(hub);
  return new Promise((resolve, reject) => {
    const ws = open(hub, scope, token);
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(give);
      if (err) {
        ws.close();
        reject(err);
      } else resolve(ws);
    };
    const give = setTimeout(
      () => done(new Error("no answer on the page within 2 minutes")),
      PENDING_MS,
    );
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Msg;
      if (m.type === "pending")
        console.error(`Pairing as "${label}". On the page, allow code  ${m.code}`);
      else if (m.type === "approved") {
        if (typeof m.token === "string") saveToken(hub, m.token, Number(m.until));
        if (!m.resumed)
          console.error(
            `Approved (${m.scope}${m.pages === "all" ? ", all pages" : Array.isArray(m.pages) ? `, ${m.pages.length} page(s)` : ""}) until ${new Date(Number(m.until)).toLocaleString()}.`,
          );
        ws.onmessage = null;
        done();
      } else if (m.type === "error" || m.type === "denied" || m.type === "expired") {
        done(new Error(String(m.error ?? m.type)));
      }
    };
    ws.onclose = (e) => {
      // A grant that lapsed or was ended: forget it, so the next run pairs.
      // A grant that lapsed, was ended, or lost all its pages: forget it, so the next run pairs.
      if ((e.code === 4498 || e.code === 4409) && token) forgetToken(hub);
      done(new Error(`socket closed (${e.code}${e.reason ? ` ${e.reason}` : ""})`));
    };
  });
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

const spillToInbox = (id: string, text: string) => {
  mkdirSync(INBOX, { recursive: true });
  const path = join(INBOX, `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`);
  writeFileSync(path, text);
  return path;
};

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
      const msg = (e as Error).message;
      console.error(`liagent: ${msg}`);
      // Every page of the grant closed: the token is forgotten; pair again now.
      if (/pair again/.test(msg)) continue;
      // Denied, ended or never answered: stop rather than prompt forever.
      if (/denied|grant is not valid|no answer|revoke/.test(msg)) process.exit(1);
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
        } else if (m.type === "error" && /pair again/.test(String(m.error)))
          console.error(`liagent: ${m.error}`);
        else if (m.type === "revoked") {
          console.error("liagent: the user ended this session.");
          forgetToken(hub);
          process.exit(0);
        }
      };
      ws.onclose = (e) => resolve(e.code);
    });
    const code = await closed;
    clearInterval(beat);
    if (code === 4409) {
      forgetToken(hub);
      console.error("liagent: every page of this grant has closed; pairing again.");
      continue;
    }
    if (code === 4401 || code === 4498) {
      forgetToken(hub);
      console.error("liagent: the grant was ended.");
      process.exit(0);
    }
    console.error(`liagent: socket closed (${code}); reconnecting in ${backoff / 1000}s`);
    await Bun.sleep(backoff);
    backoff = Math.min(backoff * 2, 60_000);
  }
}

async function main() {
  const hub = takeHub();
  if (cmd === "pair") {
    const ws = await connect(hub, { fresh: true });
    ws.close();
    return;
  }
  if (cmd === "listen") return cmdListen(hub);
  if (cmd === "say") {
    const to = flag("--to");
    const text = await readText();
    if (!text) usage(2);
    const ws = await connect(hub);
    const r = await request(ws, to ? { type: "say", text, to } : { type: "say", text }, "said");
    console.error(`said ${r.id}`);
    ws.close();
    return;
  }
  if (cmd === "busy") {
    const to = flag("--to");
    const every = Number(flag("--every") ?? 0);
    const ws = await connect(hub);
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
    const ws = await connect(hub, { scope: "eval" });
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
