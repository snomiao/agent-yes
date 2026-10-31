// The agent side of the console's debug chat (cf/liagent.ts is the hub).
//
//   bun lab/ui/debug-listen.ts <agent-yes id> [hub-url]
//
// One long-lived `liagent listen` process streams the owner's chat lines as
// NDJSON (event-driven, no polling). Each line the owner wrote is answered at
// once with a busy beat, then typed into the agent-yes session with `ay send`;
// the agent answers with `liagent say`. Never plays audio: read-aloud happens
// in the owner's browser. The ack is a silent busy beat (a spinner, no chat
// line, no speech), so it needs no quiet hours.
// Pairing is never started here (--no-pair): the owner grants it once with
// `liagent pair`, and the saved grant is resumed.

import { spawn, execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const DEFAULT_HUB = "https://agent-yes.com/_ay/chat";

export interface ChatEvent {
  type: "chat";
  id: string;
  from: "owner" | "friend";
  text: string;
  thread?: string;
}

/** A chat event from one NDJSON line, or null for anything else. */
export function parseChat(line: string): ChatEvent | null {
  let e: unknown;
  try {
    e = JSON.parse(line);
  } catch {
    return null;
  }
  const c = e as Partial<ChatEvent> | null;
  if (!c || c.type !== "chat" || typeof c.id !== "string" || typeof c.text !== "string")
    return null;
  if (c.from !== "owner" && c.from !== "friend") return null;
  return c as ChatEvent;
}

/** Only the owner's own lines are acted on; a friend's line never is. */
export function shouldAct(c: ChatEvent, seen: Set<string>): boolean {
  if (c.from !== "owner" || !c.text.trim() || seen.has(c.id)) return false;
  seen.add(c.id);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value!);
  return true;
}

const SEEN_MAX = 500;
/** `ay send` refuses over 1024 characters, envelope included. */
export const INLINE_MAX = 800;

/** The text typed into the agent-yes session; the reply command is the hub's. */
export function forAgent(c: ChatEvent, hub: string): string {
  return `[liagent ${c.id.slice(0, 8)}] the owner wrote in the console chat — reply: liagent say ${hub} "..." (--quiet for FYI or progress lines)\n${c.text}`;
}

/** Resolves with the exit code (1 when the command could not start). */
const run = (cmd: string, args: string[]) =>
  new Promise<number>((resolve) =>
    execFile(cmd, args, (err) => resolve(err ? ((err as { code?: number }).code ?? 1) : 0)),
  );

/** What to type into the session: the text itself, or the path of a 0600 file holding it. */
export function deliverable(c: ChatEvent, hub: string, dir: string): string {
  const msg = forAgent(c, hub);
  if (msg.length <= INLINE_MAX) return msg;
  const file = join(dir, `${c.id.slice(0, 8)}.txt`);
  writeFileSync(file, c.text, { mode: 0o600 });
  return `[liagent ${c.id.slice(0, 8)}] the owner wrote a long line in the console chat (full text in ${file}) — reply: liagent say ${hub} "..." (--quiet for FYI or progress lines)`;
}

async function listenOnce(agent: string, hub: string, dir: string, seen: Set<string>) {
  const child = spawn("liagent", ["listen", hub, "--no-pair"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  for await (const line of createInterface({ input: child.stdout })) {
    const c = parseChat(line);
    if (!c || !shouldAct(c, seen)) continue;
    const id = c.id.slice(0, 8);
    console.error(`liagent chat ${id}: ${c.text.length} chars`); // never the text
    if (await run("liagent", ["busy", hub])) console.error(`busy failed ${id}`);
    if (await run("ay", ["send", agent, deliverable(c, hub, dir)])) {
      console.error(`send failed ${id}`);
      await run("liagent", ["say", hub, "没送到 agent，请再发一次。"]);
    }
  }
}

export async function main(argv: string[]) {
  const [agent, hub = DEFAULT_HUB] = argv;
  if (!agent) {
    console.error("usage: debug-listen.ts <agent-yes id> [hub-url]");
    return 2;
  }
  const dir = mkdtempSync(join(tmpdir(), "ay-debug-chat-"));
  const seen = new Set<string>();
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  // liagent listen reconnects by itself; if it still exits (grant ended, crash)
  // start it again with a growing wait, not a poll.
  for (let wait = 1000; ; wait = Math.min(wait * 2, 60_000)) {
    const started = Date.now();
    await listenOnce(agent, hub, dir, seen);
    if (Date.now() - started > 60_000) wait = 1000;
    console.error(`liagent listen exited; restarting in ${wait / 1000}s`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
