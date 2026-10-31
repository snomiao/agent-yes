// The agent side of the console's debug chat (cf/liagent.ts is the hub).
//
//   bun lab/ui/debug-listen.ts <agent-yes id> [hub-url]
//
// One long-lived `liagent listen` process streams the owner's chat lines as
// NDJSON (event-driven, no polling). Each line the owner wrote is answered at
// once with a short ack, then typed into the agent-yes session with `ay send`;
// the agent answers with `liagent say`. Never plays audio: read-aloud happens
// in the owner's browser, and during quiet hours the spoken ack is skipped.
// Pairing is never started here (--no-pair): the owner grants it once with
// `liagent pair`, and the saved grant is resumed.

import { spawn, execFile } from "node:child_process";
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
  return true;
}

/** `window` is "22-7" (hours, local, wraps midnight); empty means never quiet. */
export function inQuietHours(window: string | undefined, now: Date): boolean {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(window ?? "");
  if (!m) return false;
  const [from, to, h] = [Number(m[1]), Number(m[2]), now.getHours()];
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

/** The text typed into the agent-yes session; the reply command is the hub's. */
export function forAgent(c: ChatEvent, hub: string): string {
  return `[liagent ${c.id.slice(0, 8)}] the owner wrote in the console chat — reply: liagent say ${hub} "..."\n${c.text}`;
}

const run = (cmd: string, args: string[]) =>
  new Promise<void>((resolve) => execFile(cmd, args, () => resolve()));

export async function main(argv: string[], env = process.env) {
  const [agent, hub = DEFAULT_HUB] = argv;
  if (!agent) {
    console.error("usage: debug-listen.ts <agent-yes id> [hub-url]");
    return 2;
  }
  const child = spawn("liagent", ["listen", hub, "--no-pair"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const seen = new Set<string>();
  for await (const line of createInterface({ input: child.stdout })) {
    const c = parseChat(line);
    if (!c || !shouldAct(c, seen)) continue;
    console.error(`liagent chat ${c.id.slice(0, 8)}: ${c.text.length} chars`); // never the text
    if (!inQuietHours(env.LIAGENT_QUIET, new Date())) await run("liagent", ["say", hub, "On it."]);
    await run("ay", ["send", agent, forAgent(c, hub)]);
  }
  return 1; // liagent exited
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
