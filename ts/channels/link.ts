// Channel identity + invite links — pure, isomorphic, native-free (kept off
// node-datachannel like webrtcLink.ts, so parsing/derivation never loads the
// WebRTC addon and stays unit-testable).
//
// A channel's shared secret S is the same `e1.<64hex>` value the WebRTC share
// links use (e2e.js). Everything else is derived from S so peers who hold it
// agree without exchanging anything the server can read:
//   - channelId : names the LOCAL replica file/key; topic-blind, cwd-portable.
//   - room      : the signaling rendezvous name (server sees only this + authToken).
// The topic string is a purely local label — it never appears in a link and
// never leaves the machine.

import { parseSecret, validateS } from "../../lab/ui/e2e.js";

export const CH_DEFAULT_SIGHOST = "s.agent-yes.com";

const HEX64 = /^[0-9a-f]{64}$/;
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

async function sha256Hex(input: string): Promise<string> {
  const digest = new Uint8Array(await subtle.digest("SHA-256", enc.encode(input)));
  let s = "";
  for (const b of digest) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Local replica id: `sha256("ay/ch/id\n" + S)[:16]`. Topic-blind. */
export async function deriveChannelId(s: string): Promise<string> {
  return (await sha256Hex(`ay/ch/id\n${validateS(s)}`)).slice(0, 16);
}

/** Signaling rendezvous name: `"c" + sha256("ay/ch/room\n" + S)[:12]`. */
export async function deriveRoom(s: string): Promise<string> {
  return "c" + (await sha256Hex(`ay/ch/room\n${validateS(s)}`)).slice(0, 12);
}

export interface ChannelLink {
  sighost: string;
  room: string;
  /** The raw 64-hex secret S (marker stripped). */
  s: string;
}

/** True if `str` looks like a channel invite link. */
export function isChannelLink(str: string): boolean {
  return str.startsWith("ay://ch/") || (/^https?:\/\//.test(str) && str.includes("#ch="));
}

/**
 * Format a channel invite:
 *   ay://ch/<sighost>/<room>#e1.<64hex>
 * The secret rides the fragment; on the https form it is never sent to a server.
 */
export function formatChannelLink(link: ChannelLink): string {
  return `ay://ch/${link.sighost}/${link.room}#e1.${validateS(link.s)}`;
}

/** Browser-console form: https://<host>/w/#ch=<room>:e1.<64hex>[@<sighost>]. */
export function formatChannelWebLink(link: ChannelLink, webHost = "agent-yes.com"): string {
  const at = link.sighost === CH_DEFAULT_SIGHOST ? "" : `@${link.sighost}`;
  return `https://${webHost}/w/#ch=${link.room}:e1.${validateS(link.s)}${at}`;
}

/**
 * Parse either invite form back into { sighost, room, s }. Returns null if the
 * string isn't a recognizable channel link; throws (via parseSecret) if the
 * secret slot is present but malformed — never silently downgrades.
 */
export function parseChannelLink(link: string): ChannelLink | null {
  const ay = /^ay:\/\/ch\/([^/]+)\/([^#]+)#(.+)$/.exec(link);
  if (ay) {
    const { s } = parseSecret(ay[3]!);
    if (!HEX64.test(s)) throw new Error("malformed channel link");
    return { sighost: ay[1]!, room: ay[2]!, s };
  }
  if (/^https?:\/\//.test(link) && link.includes("#ch=")) {
    const frag = link.split("#ch=")[1] ?? "";
    const at = frag.split("@");
    const sighost = at[1] || CH_DEFAULT_SIGHOST;
    const seg = at[0]!;
    const i = seg.indexOf(":");
    if (i < 0) return null;
    const { s } = parseSecret(seg.slice(i + 1));
    if (!HEX64.test(s)) throw new Error("malformed channel link");
    return { sighost, room: seg.slice(0, i), s };
  }
  return null;
}
