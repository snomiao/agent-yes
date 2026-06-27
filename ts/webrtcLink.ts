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

/**
 * Parse a share link into { room, secret, signaling-host }. Accepts:
 *   webrtc://<room>:<token>@<host>
 *   https://<anyhost>/w/#<room>:<token>            (signaling host defaults to s.agent-yes.com)
 *   https://<anyhost>/w/#<room>:<token>@<sighost>  (explicit signaling host)
 * Returns null if the string isn't a recognizable share link.
 */
export function parseWebrtcLink(link: string): WebrtcLink | null {
  const wr = /^webrtc:\/\/([^:]+):([^@]+)@(.+)$/.exec(link);
  if (wr) {
    const { s } = parseSecret(wr[2]!);
    return { room: wr[1]!, s, host: wr[3]! };
  }
  if (/^https?:\/\//.test(link) && link.includes("#")) {
    const frag = link.split("#")[1] ?? "";
    const at = frag.split("@");
    const host = at[1] || DEFAULT_SIGHOST;
    const seg = at[0]!;
    const i = seg.indexOf(":");
    if (i < 0) return null;
    const { s } = parseSecret(seg.slice(i + 1));
    return { room: seg.slice(0, i), s, host };
  }
  return null;
}

/** True if `spec` looks like a WebRTC share link (vs. an http remote or alias). */
export function isWebrtcSpec(spec: string): boolean {
  return spec.startsWith("webrtc://") || (/^https?:\/\//.test(spec) && spec.includes("#"));
}
