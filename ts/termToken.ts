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

export interface TermScope {
  /** The agent pid this token is bound to (resolved to a concrete pid at mint time). */
  pid: string;
  /** Interactive: may also write to this pid's stdin (/api/send). Read-only when false. */
  canSend: boolean;
  /** Expiry, epoch seconds. */
  exp: number;
}

const PREFIX = "ayt1";

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

/** Mint a scoped token bound to `scope.pid`, signed with the master token. */
export function mintTermToken(masterToken: string, scope: TermScope): string {
  const payload = Buffer.from(
    JSON.stringify({ p: scope.pid, w: scope.canSend ? 1 : 0, x: Math.floor(scope.exp) }),
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
  let obj: { p?: unknown; w?: unknown; x?: unknown };
  try {
    obj = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
  if (typeof obj.p !== "string" || !obj.p) return null;
  if (typeof obj.x !== "number" || !Number.isFinite(obj.x) || obj.x <= nowSec) return null; // expired
  return { pid: obj.p, canSend: obj.w === 1, exp: obj.x };
}
