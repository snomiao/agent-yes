// "Pair a machine": mint a room the console waits in, and render the install
// one-liners that attach a machine to it.
//
// This INVERTS the usual direction. Normally the host mints the room — `ay
// serve --webrtc` with a bare flag makes room+secret and prints a link you
// carry to the console (ts/share.ts). That needs agent-yes already installed,
// so it can't be the first thing a new machine does. Here the console mints
// first, so a machine with nothing on it is attached by pasting one command.
//
// The crypto is unchanged: same room/secret shape as ts/share.ts (`r`+12 hex,
// 256-bit S) and the same `e1.` encrypted-link marker, so S rides in a URL
// fragment that never reaches a server and the signaling host only ever sees
// HKDF(S, …). See lab/ui/e2e.js for the threat model.

/** Encrypted-link marker; must match e2e.js MARKER (`e${V}.`). */
export const MARKER = "e1.";

/** Default signaling host — mirrors SIG_DEFAULT in lab/ui/rtc.js. */
export const SIG_DEFAULT = "s.agent-yes.com";

export interface Pairing {
  /** Room id — a non-secret mnemonic (`r` + 12 hex). */
  room: string;
  /** `e1.<64hex>` — what the console's RTC wire authenticates with. */
  token: string;
  /** The room link carrying S in its fragment. */
  link: string;
  /** POSIX one-liner (sh/bash/zsh). */
  sh: string;
  /** PowerShell one-liner. */
  ps: string;
}

type RandomFill = (buf: Uint8Array) => void;

const defaultRandom: RandomFill = (buf) => globalThis.crypto.getRandomValues(buf);

function hex(bytes: number, rand: RandomFill): string {
  const buf = new Uint8Array(bytes);
  rand(buf);
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Refuse to emit a command we cannot quote safely.
 *
 * Both one-liners wrap the link in single quotes so neither shell can act on
 * the `&` and `#` it always contains. A single quote in the link would end
 * that quoting and turn the rest into shell words, so it can never be allowed
 * through — nor can whitespace or a control byte. Generated links can't
 * contain any of them (room is `r`+hex, S is hex), which is exactly why this
 * throws rather than escapes: reaching it means the shape changed upstream and
 * the caller should stop, not paper over it. room.html makes the same check on
 * the links it is handed.
 */
export function assertShellSafe(link: string): string {
  // Quote/backslash/whitespace, plus C0 and DEL — a control byte in a pasted
  // command is never legitimate here.
  // eslint-disable-next-line no-control-regex
  if (/['"\\\s]|[\u0000-\u001f\u007f]/.test(link)) throw new Error("unsafe room link");
  return link;
}

/**
 * Build both install one-liners for an already-minted room link.
 *
 * The secret rides in the ENVIRONMENT, never in argv. On Linux
 * /proc/<pid>/cmdline is world-readable, so an argument would expose the room
 * secret to every local user for as long as the installer runs, while
 * /proc/<pid>/environ is owner+root only. setup.sh documents the same rule for
 * its `--join` flag, and room.html builds the POSIX form this way already.
 *
 * The PowerShell form is deliberately NOT wrapped in `powershell -c "…"` the
 * way the plain installer is. That wrapper is what lets the plain one-liner
 * also run from cmd, but it is actively wrong here: pasted into PowerShell,
 * the OUTER shell expands `$env:AY_JOIN` inside the double quotes — to the
 * empty string, since it isn't set yet — and the inner shell receives
 * `='https://…'; irm …`, a syntax error. Emitting the native form means it
 * works when pasted where a Windows user actually pastes it.
 */
export function pairingCommands(opts: { origin: string; link: string }): {
  sh: string;
  ps: string;
} {
  const link = assertShellSafe(opts.link);
  const origin = opts.origin.replace(/\/+$/, "");
  return {
    sh: `AY_JOIN='${link}' sh -c "$(curl -fsSL ${origin}/setup.sh)"`,
    ps: `$env:AY_JOIN='${link}'; irm ${origin}/setup.ps1 | iex`,
  };
}

/**
 * Mint a fresh single-machine room and the commands that join it.
 *
 * One pairing is one machine: a share room has a single host, so a second
 * paste displaces the first. `AY_FLEET` is the reusable-token shape for the
 * many-machines case (see setup.sh).
 */
export function mintPairing(
  opts: { origin: string; sigHost?: string; rand?: RandomFill } = { origin: "" },
): Pairing {
  const rand = opts.rand ?? defaultRandom;
  const origin = opts.origin.replace(/\/+$/, "");
  const sigHost = opts.sigHost && opts.sigHost !== SIG_DEFAULT ? opts.sigHost : "";
  // Same shapes as ts/share.ts: a short non-secret room mnemonic + 256-bit S.
  const room = "r" + hex(6, rand);
  const token = MARKER + hex(32, rand);
  const link =
    `${origin}/room/#room=${encodeURIComponent(room)}&s=${encodeURIComponent(token)}` +
    (sigHost ? `&sig=${encodeURIComponent(sigHost)}` : "");
  const { sh, ps } = pairingCommands({ origin, link });
  return { room, token, link, sh, ps };
}
