// Pure parsing/detection for WebRTC share links. Kept free of node-datachannel
// (the native WebRTC dep) so callers — and resolveRemoteSpec on every remote
// command — can detect/parse a link without loading the native module, and so
// the helpers stay unit-testable. The actual connection lives in webrtcRemote.ts.
import { parseSecret } from "../lab/ui/e2e.js";

export const SIGNAL_SUBPROTOCOL = "ay-signal-1";
export const DEFAULT_SIGHOST = "s.agent-yes.com";

export interface WebrtcLink {
  room: string;
  s: string;
  host: string;
}

/** room + RAW token (marker and all), before parseSecret strips the `e1.`. */
interface RawLink {
  room: string;
  token: string;
  host: string;
}

// The fragment of a /room/ link is a key=value set, parsed with URLSearchParams:
//
//   https://agent-yes.com/room/#room=<id>&s=e1.<64hex>[&sig=<host>]
//
// Positional (#<room>:<token>[@<sighost>]) is the older /w/ console form, kept
// working forever for saved links and PWA caches. New links use key=value
// because the fragment namespace is shared with #k=, #ch= and #launch=, and the
// positional grammar can only be told apart from those by a blocklist that has
// to be updated for every new key (see parseRoomHash in lab/ui/rtc.js). A leading
// "?" is tolerated (#?room=…) since that spelling is also in the wild.
//
// NOTE: URLSearchParams percent-decodes and reads "+" as a space. The secret is
// `e1.` + hex so it survives untouched, but any future value must be written
// with encodeURIComponent.
function parseFragment(frag: string): RawLink | null {
  if (/^\??[A-Za-z_]+=/.test(frag)) {
    const q = new URLSearchParams(frag.replace(/^\?/, ""));
    const room = q.get("room");
    const token = q.get("s");
    if (!room || !token) return null;
    return { room, token, host: q.get("sig") || DEFAULT_SIGHOST };
  }
  const at = frag.split("@");
  const seg = at[0]!;
  const i = seg.indexOf(":");
  if (i < 0) return null;
  return { room: seg.slice(0, i), token: seg.slice(i + 1), host: at[1] || DEFAULT_SIGHOST };
}

/** Parse a share link WITHOUT validating/stripping the secret's version marker. */
function parseRaw(link: string): RawLink | null {
  const wr = /^webrtc:\/\/([^:]+):([^@]+)@(.+)$/.exec(link);
  if (wr) return { room: wr[1]!, token: wr[2]!, host: wr[3]! };
  if (/^https?:\/\//.test(link) && link.includes("#"))
    return parseFragment(link.split("#")[1] ?? "");
  return null;
}

/**
 * Parse a share link into { room, secret, signaling-host }. Accepts:
 *   webrtc://<room>:<token>@<host>                    (internal / legacy form)
 *   https://<anyhost>/room/#room=<id>&s=<token>[&sig=<host>]
 *   https://<anyhost>/w/#<room>:<token>[@<sighost>]   (older positional form)
 * Returns null if the string isn't a recognizable share link.
 */
export function parseWebrtcLink(link: string): WebrtcLink | null {
  const raw = parseRaw(link);
  if (!raw) return null;
  const { s } = parseSecret(raw.token);
  return { room: raw.room, s, host: raw.host };
}

/**
 * Normalize any accepted share-link spelling to the internal
 * `webrtc://<room>:<token>@<host>` form that startShare/parseShareUrl consume.
 * Returns the RAW token, so a legacy markerless room round-trips unchanged
 * instead of being handed a marker it never had.
 */
export function toWebrtcUrl(link: string): string | null {
  const raw = parseRaw(link);
  return raw ? `webrtc://${raw.room}:${raw.token}@${raw.host}` : null;
}

/** True if `spec` looks like a WebRTC share link (vs. an http remote or alias). */
export function isWebrtcSpec(spec: string): boolean {
  return spec.startsWith("webrtc://") || (/^https?:\/\//.test(spec) && spec.includes("#"));
}
