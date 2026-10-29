// The reply route of a message that crossed a shared room.
//
// The sender builds the <ay-msg …> header (subcommands.ts buildEnvelope) but
// cannot know what the RECEIVER calls the room, so its reply hint names the
// room instead: `ay send <alias-for-room-<room id>>:<member>:<agent>`. The
// receiving host knows its own aliases (~/.agent-yes/remotes.yaml) and fills
// the placeholder in before the message reaches the agent, so the agent gets a
// command it can run as is (`ay send fleet:worker-d:<agent>`). The Rust daemon
// does the same in rs/src/serve/reply_alias.rs.

import { readFile } from "fs/promises";
import { hostname } from "os";
import path from "path";
import { agentYesHome } from "./agentYesHome.ts";
import { readRemotes } from "./remotes.ts";
import { parseWebrtcLink } from "./webrtcLink.ts";

export function roomAliasPlaceholder(room: string): string {
  return `<alias-for-room-${room}>`;
}

const PLACEHOLDER = /<alias-for-room-([A-Za-z0-9_-]{1,64})>/g;

/**
 * `msg` with the room placeholders in its envelope header replaced by the
 * receiver's alias for that room. Only the first line, and only when it is an
 * <ay-msg …> header: the body is the sender's text and is never rewritten.
 */
export function fillRoomAlias(msg: string, aliasFor: (room: string) => string | undefined): string {
  if (!msg.startsWith("<ay-msg ")) return msg;
  const nl = msg.indexOf("\n");
  const head = nl < 0 ? msg : msg.slice(0, nl);
  const filled = head.replace(PLACEHOLDER, (all, room: string) => aliasFor(room) ?? all);
  return filled === head ? msg : filled + (nl < 0 ? "" : msg.slice(nl));
}

/** This machine's aliases for share rooms: room id → alias. */
export async function roomAliases(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [alias, cfg] of await readRemotes().catch(() => new Map())) {
    const room = parseWebrtcLink(String(cfg?.url ?? ""))?.room;
    if (room && !out.has(room)) out.set(room, alias);
  }
  return out;
}

/**
 * Sender side: `{id, member}` when this machine hosts in `room` right now (its
 * ayrs holds `~/.agent-yes/.share-host-<room>.pid`, see rs/src/serve/share.rs),
 * so a reply addressed `<room alias>:<member>:<agent>` reaches us. Undefined
 * otherwise — a machine that only views the room cannot be replied to through it.
 */
export async function hostedRoomMember(
  room: string | undefined,
): Promise<{ id: string; member: string } | undefined> {
  if (!room) return undefined;
  try {
    const lock = path.join(agentYesHome(), `.share-host-${room}.pid`);
    const pid = parseInt(await readFile(lock, "utf-8"), 10);
    if (!(pid > 0)) return undefined;
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "EPERM") return undefined;
  }
  // The name ayrs announces (rs/src/serve/room_member.rs member_name).
  return { id: room, member: process.env.AY_NAME?.trim() || hostname() };
}
