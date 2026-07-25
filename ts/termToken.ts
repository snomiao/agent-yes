// Scoped terminal-embed tokens — a capability you can safely put in a web page.
//
// The serve daemon's MASTER token (~/.agent-yes/.serve-token) is full-fleet
// read+write+spawn = RCE; it must NEVER land in an embed. A scoped token instead
// grants a NARROW capability: read (and optionally write to) exactly ONE agent
// session, and only until it expires. It is a stateless HMAC bearer token — the
// daemon verifies it with the same master token it already holds, so there is no
// server-side token store to manage or revoke (short TTL is the bound).
//
//   ayt1.<payloadB64url>.<sigB64url>
//     payload = {p: <pid>, w: 0|1 (write/interactive), x: <exp epoch-seconds>}
//     sig     = HMAC-SHA256(keyFor(masterToken), "ayt1.<payloadB64url>")
//
// `ay term mint` signs one locally (it can read the master token file); the
// daemon's checkAuth verifies it and confines the request to the bound pid.
// (ed25519 per-author signing is a stronger future form; symmetric HMAC already
// delivers short-TTL + read-only + single-session, which is what embeds need.)
import { createHash, createHmac, timingSafeEqual } from "crypto";

/** Capability vocabulary a scoped token can carry (see scopedGate in serve.ts). */
export type Cap = "tail" | "size" | "send" | "resize" | "read" | "screenshot";

export interface TermScope {
  /** Subject the token is bound to: an agent pid (terminal) or a viewer id (widget). */
  pid: string;
  /** Convenience mirror of caps.includes("send") — interactive terminal write. */
  canSend: boolean;
  /** Full capability list this token grants for its subject. */
  caps: string[];
  /** Expiry, epoch seconds. */
  exp: number;
}

const PREFIX = "ayt1";

const CAPS_READONLY: Cap[] = ["tail", "size"];
const CAPS_INTERACTIVE: Cap[] = ["tail", "size", "send", "resize"];
/** Derive caps for a legacy `{w}` token (pre-caps format): w=1 ⇒ interactive. */
function legacyCaps(w: unknown): string[] {
  return w === 1 ? [...CAPS_INTERACTIVE] : [...CAPS_READONLY];
}

/** Dedicated HMAC key derived from the master token (so the token isn't signed with the raw master). */
function keyFor(masterToken: string): Buffer {
  return createHash("sha256")
    .update("ay/term/token/v1\n" + masterToken)
    .digest();
}

/** True for anything shaped like a scoped terminal token (cheap pre-check before verify). */
export function isTermToken(tok: unknown): tok is string {
  return typeof tok === "string" && tok.startsWith(PREFIX + ".");
}

/**
 * Mint a scoped token bound to `scope.pid` (the subject), signed with the master
 * token. `caps` is authoritative; if omitted it derives from `canSend` (terminal
 * back-compat). Emits the caps-format payload `{s, c, x}` (verified alongside the
 * legacy `{p, w, x}`).
 */
export function mintTermToken(
  masterToken: string,
  scope: { pid: string; exp: number; caps?: string[]; canSend?: boolean },
): string {
  const caps = scope.caps ?? (scope.canSend ? [...CAPS_INTERACTIVE] : [...CAPS_READONLY]);
  const payload = Buffer.from(
    JSON.stringify({ s: scope.pid, c: caps, x: Math.floor(scope.exp) }),
  ).toString("base64url");
  const body = `${PREFIX}.${payload}`;
  const sig = createHmac("sha256", keyFor(masterToken)).update(body).digest().toString("base64url");
  return `${body}.${sig}`;
}

/**
 * Verify a scoped token against the master token. Returns the scope if the
 * signature is valid AND it hasn't expired, else null. Fail-closed on any
 * malformed input. `nowSec` is injectable for tests.
 */
export function verifyTermToken(
  masterToken: string,
  tok: unknown,
  nowSec: number = Math.floor(Date.now() / 1000),
): TermScope | null {
  if (!isTermToken(tok)) return null;
  const parts = tok.split(".");
  if (parts.length !== 3) return null;
  const body = `${parts[0]}.${parts[1]}`;
  const expected = createHmac("sha256", keyFor(masterToken)).update(body).digest();
  let got: Buffer;
  try {
    got = Buffer.from(parts[2]!, "base64url");
  } catch {
    return null;
  }
  // constant-time compare; length check first (timingSafeEqual throws on mismatch)
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  let obj: { s?: unknown; p?: unknown; w?: unknown; c?: unknown; x?: unknown };
  try {
    obj = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
  // subject: new tokens use `s`, legacy tokens use `p`
  const sub = typeof obj.s === "string" && obj.s ? obj.s : obj.p;
  if (typeof sub !== "string" || !sub) return null;
  if (typeof obj.x !== "number" || !Number.isFinite(obj.x) || obj.x <= nowSec) return null; // expired
  // caps: new tokens carry `c`; legacy tokens derive from `w`
  const caps = Array.isArray(obj.c)
    ? (obj.c.filter((x) => typeof x === "string") as string[])
    : legacyCaps(obj.w);
  return { pid: sub, canSend: caps.includes("send"), caps, exp: obj.x };
}
