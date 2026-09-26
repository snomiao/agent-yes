// "Pair a machine": mint a room a console can watch, and render the install
// one-liners that attach a machine to it.
//
// ONE implementation, shared by every page that offers pairing so they can
// never diverge (the same rule e2e.js follows):
//   - the landing page (lab/ui/landing.html) imports it over HTTP as
//     /w/pairing.js — build-assets.sh copies lab/ui/*.js into public/w/
//   - the rgui console (lab/ui/rgui/main.ts) imports it as ../pairing.js and
//     bundles it via scripts/build-rgui.ts
//   - the test suite (tests/ui-logic/pairing.spec.ts) imports it directly
//
// This INVERTS the usual direction. Normally the host mints the room — `ay
// serve --webrtc` with a bare flag makes room+secret and prints a link you
// carry to the console (ts/share.ts). That needs agent-yes already installed,
// so it can't be the first thing a new machine does. Here the browser mints
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

/**
 * @typedef {object} Pairing
 * @property {string} room  Room id — a non-secret mnemonic (`r` + 12 hex).
 * @property {string} token `e1.<64hex>` — what a console's RTC wire authenticates with.
 * @property {string} link  The room link carrying S in its fragment.
 * @property {string} sh    POSIX one-liner (sh/bash/zsh).
 * @property {string} ps    PowerShell one-liner.
 * @property {string} consoleUrl  Console deep link that connects to this room.
 */

/** @typedef {(buf: Uint8Array) => void} RandomFill */

/** @type {RandomFill} */
const defaultRandom = (buf) => globalThis.crypto.getRandomValues(buf);

/**
 * @param {number} bytes
 * @param {RandomFill} rand
 * @returns {string}
 */
function hex(bytes, rand) {
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
 *
 * @param {string} link
 * @returns {string}
 */
export function assertShellSafe(link) {
  // Quote/backslash/whitespace, plus C0 and DEL — a control byte in a pasted
  // command is never legitimate here.
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
 *
 * @param {{origin: string, link: string}} opts
 * @returns {{sh: string, ps: string}}
 */
export function pairingCommands(opts) {
  const link = assertShellSafe(opts.link);
  const origin = opts.origin.replace(/\/+$/, "");
  return {
    sh: `AY_JOIN='${link}' sh -c "$(curl -fsSL ${origin}/setup.sh)"`,
    ps: `$env:AY_JOIN='${link}'; irm ${origin}/setup.ps1 | iex`,
  };
}

/**
 * The console deep link for a pairing — where the operator goes to watch the
 * machine arrive and then drive it.
 *
 * Uses the positional `#<room>:<token>[@<sighost>]` form that /w/ has always
 * read (parseRoomHash in rtc.js), which is also what room.html hands out. Like
 * every other carrier of S this is a FRAGMENT, so the secret is never sent to
 * the server that serves the console.
 *
 * @param {{origin: string, room: string, token: string, sigHost?: string}} opts
 * @returns {string}
 */
export function consoleUrlFor(opts) {
  const origin = opts.origin.replace(/\/+$/, "");
  const sig = opts.sigHost && opts.sigHost !== SIG_DEFAULT ? "@" + opts.sigHost : "";
  return (
    `${origin}/w/#` + encodeURIComponent(opts.room) + ":" + encodeURIComponent(opts.token) + sig
  );
}

/**
 * Mint a fresh single-machine room and everything needed to join and watch it.
 *
 * One pairing is one machine: a star room has a single host, so a second paste
 * displaces the first. `AY_FLEET` is the reusable-token shape for the
 * many-machines case (see setup.sh).
 *
 * @param {{origin: string, sigHost?: string, rand?: RandomFill}} opts
 * @returns {Pairing}
 */
export function mintPairing(opts = { origin: "" }) {
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
  return {
    room,
    token,
    link,
    sh,
    ps,
    consoleUrl: consoleUrlFor({ origin, room, token, sigHost }),
  };
}
