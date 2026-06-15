// agent-yes end-to-end encryption for the WebRTC share DataChannel (protocol
// "ay-e2e-1", URL marker "e1.").
//
// ONE implementation, shared by both ends so they can never diverge:
//   - the browser console (lab/ui/index.html) imports it over HTTP as ./e2e.js
//   - the host (ts/share.ts, lab/ui/share-host.ts) bundles it via a relative
//     import — Bun ships WebCrypto, so the same code runs on both ends
//   - the test suite (tests/e2e-crypto.test.ts) imports it under Node's WebCrypto
//
// Threat model: a fully compromised signaling Durable Object (lab/ui/cf/worker.ts)
// — or an active MITM on the WebRTC media path — may DoS and observe metadata, but
// MUST NOT read terminal I/O, inject input, spawn agents, or recover the secret S
// or any AES key. The signaling server only ever sees `authToken = HKDF(S,…)`,
// which is one-way; the AES keys never leave the endpoints.
//
// See agent-yes.com/blog/e2ee-share-links for the design writeup.

export const V = 1;
export const PROTO = `ay-e2e-${V}`; // "ay-e2e-1"
export const MARKER = `e${V}.`; // "e1."
const INFO_AUTH = `ay/${PROTO}/auth`;
const INFO_H2C = `ay/${PROTO}/key/host->client`;
const INFO_C2H = `ay/${PROTO}/key/client->host`;
export const MAX_CHUNK = 12_000; // bytes of plaintext per sealed frame, << SCTP max
export const CONFIRM_TIMEOUT_MS = 5_000; // bidirectional key-confirmation deadline
export const ALLOW_LEGACY_PLAINTEXT = false; // NEVER silently downgrade to plaintext

const VER = 0x01; // frame version byte
export const FLAG_CONFIRM = 0x01; // FLAGS bit: key-confirmation frame
const HEADER_LEN = 14; // VER(1) + FLAGS(1) + NONCE(12)
const NONCE_LEN = 12;
const TAG_LEN = 16; // AES-GCM tag, appended to ciphertext (WebCrypto convention)
const COUNTER_MAX = (1n << 64n) - 1n;

// Startup self-check: the single version source must be internally consistent, so
// a future bump can't leave the marker, info strings, and PROTO disagreeing.
if (PROTO !== `ay-e2e-${V}` || MARKER !== `e${V}.` || !INFO_AUTH.startsWith(`ay/${PROTO}/`)) {
  throw new Error("e2e: version constants disagree");
}

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
const HEX64 = /^[0-9a-f]{64}$/;

// ---- small byte helpers ----------------------------------------------------
function concatBytes(...arrs) {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(b) {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}
async function sha256(bytes) {
  return new Uint8Array(await subtle.digest("SHA-256", bytes));
}
async function hkdf32(ikm, salt, info) {
  const base = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode(info) },
    base,
    256,
  );
  return new Uint8Array(bits);
}

// ---- secret validation + key derivation -----------------------------------

// Reject anything that isn't a full-entropy 64-hex secret BEFORE it reaches HKDF.
// Fail-closed, and the error never echoes the input (no token in logs).
export function validateS(s) {
  if (typeof s !== "string" || !HEX64.test(s)) throw new Error("invalid share token");
  return s;
}
function ikmFromS(s) {
  return hexToBytes(validateS(s)); // IKM is the 32 raw bytes, never the 64 ASCII chars
}

// The ONLY value the signaling server sees. Salted with the room+sighost context
// (one-way) so it can't be used to link the same S across rooms, and so a hacked
// server learns nothing about S or the AES keys.
export async function deriveAuthToken(s, room, sighost) {
  const salt = await sha256(enc.encode(`${room}\n${sighost}`));
  return bytesToHex(await hkdf32(ikmFromS(s), salt, INFO_AUTH));
}

async function importAesKey(raw) {
  return subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// The two directional AES-256-GCM keys, derived AFTER the DTLS handshake so the
// per-connection transcriptHash is the HKDF salt: every session/peer therefore
// gets fresh keys, which is what makes a counter that restarts at 0 always safe
// (no cross-session (key,nonce) reuse). Directional keys also mean the two senders
// never share a nonce space. HOST encrypts keyH2C / decrypts keyC2H; CLIENT the
// mirror. These keys never leave the machine.
export async function deriveDirKeys(s, transcriptHash) {
  const ikm = ikmFromS(s);
  const h2c = await hkdf32(ikm, transcriptHash, INFO_H2C);
  const c2h = await hkdf32(ikm, transcriptHash, INFO_C2H);
  return { keyH2C: await importAesKey(h2c), keyC2H: await importAesKey(c2h) };
}

// ---- transcript hash (channel binding) ------------------------------------

function allFingerprints(sdp) {
  const out = [];
  const re = /^a=fingerprint:(.*)$/gim;
  let m;
  while ((m = re.exec(sdp))) out.push(m[1].trim().toLowerCase());
  return out;
}
function firstAttr(sdp, name) {
  const m = new RegExp(`^a=${name}:(.*)$`, "im").exec(sdp);
  return m ? m[1].trim().toLowerCase() : "";
}

// Bind the session to the negotiated DTLS handshake by hashing both peers'
// fingerprints (session- and media-level), DTLS setup role, and ICE ufrag. Used
// as BOTH the HKDF salt for the directional keys AND the AEAD AAD on every frame,
// so a relay that can't reproduce the exact transcript can neither derive the keys
// nor forge a frame. Host passes offer=local/answer=remote; client passes
// offer=remote/answer=local — both compute the identical string. Fail-closed if a
// side has no fingerprint or offers a non-sha-256 (downgrade) fingerprint.
export async function computeTranscriptHash(offerSdp, answerSdp) {
  const offerFps = allFingerprints(offerSdp).sort();
  const answerFps = allFingerprints(answerSdp).sort();
  if (!offerFps.length || !answerFps.length) throw new Error("e2e: missing DTLS fingerprint");
  for (const fp of offerFps.concat(answerFps)) {
    if (!fp.startsWith("sha-256")) throw new Error("e2e: non-sha-256 DTLS fingerprint");
  }
  const input =
    `${PROTO}\n` +
    `offer=${offerFps.join(",")};setup=${firstAttr(offerSdp, "setup")};ufrag=${firstAttr(offerSdp, "ice-ufrag")}\n` +
    `answer=${answerFps.join(",")};setup=${firstAttr(answerSdp, "setup")};ufrag=${firstAttr(answerSdp, "ice-ufrag")}`;
  return await sha256(enc.encode(input));
}

// ---- AEAD frame seal / open -----------------------------------------------
// Wire frame: VER(1) | FLAGS(1) | NONCE(12) | CIPHERTEXT | TAG(16)
//   NONCE = [4-byte BE epoch = 0] | [8-byte BE monotonic per-direction counter]
//   AAD   = header(14) | transcriptHash(32)   (on every frame)

function nonceFromCounter(ctr) {
  const n = new Uint8Array(NONCE_LEN); // bytes 0..3 epoch stay 0 in v2
  new DataView(n.buffer).setBigUint64(4, ctr, false);
  return n;
}

// sendState: { sendCtr: bigint }. The counter is captured-and-incremented
// synchronously BEFORE the await, so concurrent seals can never reuse a nonce.
export async function seal(key, sendState, flags, transcriptHash, plaintext) {
  const ctr = sendState.sendCtr;
  if (ctr >= COUNTER_MAX) throw new Error("e2e: nonce counter overflow");
  sendState.sendCtr = ctr + 1n;
  const nonce = nonceFromCounter(ctr);
  const header = new Uint8Array(HEADER_LEN);
  header[0] = VER;
  header[1] = flags & 0xff;
  header.set(nonce, 2);
  const aad = concatBytes(header, transcriptHash);
  const sealed = new Uint8Array(
    await subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
      key,
      plaintext,
    ),
  );
  return concatBytes(header, sealed).buffer; // ArrayBuffer, ready for dc.send
}

// recvState: { lastSeen: bigint } (init -1n). Throws (fail-closed) on bad
// version/epoch, auth/AAD failure, or replay/reorder (counter <= lastSeen). The
// caller MUST close the channel on any throw — never fall through to JSON.parse.
export async function open(key, frame, transcriptHash, recvState) {
  const buf = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (buf.length < HEADER_LEN + TAG_LEN) throw new Error("e2e: short frame");
  if (buf[0] !== VER) throw new Error("e2e: bad version");
  const header = buf.subarray(0, HEADER_LEN);
  const nonce = buf.subarray(2, HEADER_LEN);
  const ndv = new DataView(nonce.buffer, nonce.byteOffset, NONCE_LEN);
  if (ndv.getUint32(0, false) !== 0) throw new Error("e2e: bad epoch");
  const ctr = ndv.getBigUint64(4, false);
  const sealed = buf.subarray(HEADER_LEN);
  const aad = concatBytes(header, transcriptHash);
  const ptBuf = await subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
    key,
    sealed,
  ); // throws on auth/AAD failure
  // The first accepted frame of a session MUST be counter-0 (the confirmation
  // frame). Anything else means a skipped/forged opening frame — fail closed,
  // so a counter can't jump ahead and strand the real opening frames as "replay".
  if (recvState.lastSeen === -1n && ctr !== 0n)
    throw new Error("e2e: first frame must be counter-0");
  if (ctr <= recvState.lastSeen) throw new Error("e2e: replay/reorder");
  recvState.lastSeen = ctr;
  return { counter: ctr, flags: header[1], plaintext: new Uint8Array(ptBuf) };
}

// ---- envelope (the {t:…} JSON), sealed as UTF-8 bytes ---------------------
export function packEnvelope(obj) {
  return enc.encode(JSON.stringify(obj));
}
export function unpackEnvelope(bytes) {
  return JSON.parse(dec.decode(bytes));
}

// ---- URL secret marker grammar (strict, fail-closed) ----------------------
// Parses the secret slot of a share link. Returns { s, v2 }:
//   "e1.<64hex>"  -> { s, v2:true }                 (v2 encrypted link)
//   "<64hex>" / other custom token -> { s, v2:false } (legacy; gated by caller)
// A token that LOOKS like a version marker but isn't exactly "e1.<64hex>" is
// rejected outright — it must never silently fall back to a legacy/plaintext path.
export function parseSecret(token) {
  const mk = /^e(\d+)\.(.*)$/.exec(token);
  if (mk) {
    if (mk[1] !== String(V)) throw new Error("update required");
    if (!HEX64.test(mk[2])) throw new Error("malformed encrypted link");
    return { s: mk[2], v2: true };
  }
  if (/^e\d/i.test(token)) throw new Error("malformed encrypted link");
  return { s: token, v2: false };
}

// Random hex string of n bytes — confirmation challenge nonces, request ids.
export function randomHex(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return bytesToHex(b);
}
