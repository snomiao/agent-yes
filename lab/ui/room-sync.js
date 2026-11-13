// "Sync my rooms": the saved-rooms list (localStorage "ay.rooms"), synced across
// a user's browsers through their own Google Drive, end-to-end encrypted.
//
// Imported directly by the console (index.html) and bundled into /r/ (rgui), and
// unit-tested in tests/ui-logic/room-sync.spec.ts. Everything that touches the
// network, the clock or storage is injected, so the logic here is testable.
//
// Trust model. Each saved room carries its share token, which alone grants full
// access to that room. The list is encrypted in the browser with a key derived
// from a sync passphrase the user types once per device (PBKDF2-SHA256 →
// AES-GCM), then stored in the user's Drive app folder (drive.appdata scope).
// Sign-in (better-auth on agent-yes.com, see cf/auth.ts) only hands the browser
// a short-lived Drive access token; the Worker never sees the list or the key.
// Whoever holds Drive access can delete the file or put back an older copy, but
// cannot read it: the worst case is forgotten rooms reappearing, not a leak.
//
// Merge. A saved room carries two times: `ts`, refreshed on every connect (last
// used; drives the 90-day expiry and the panel's order), and `added`, set only
// when the room or its token first lands on a device. Rooms merge by name;
// between two different tokens the newer `added` wins. "Forget" records a
// removal time (localStorage "ay.roomsRemoved") that beats any copy ADDED before
// it. Comparing against `ts` instead would let any other device that merely
// reconnected the room (every page load does) undo the forget. Rooms older than
// ROOM_TTL_MS are dropped on every device WITHOUT a removal record: the
// per-device 90-day expiry must never wipe a room from other devices that still
// use it. codehost rooms are local-only and never leave the device.
//
// Per-room choice. A room is either synced or "device only" (`localOnly: true`
// on its entry), never both. Device-only rooms behave like codehost rooms: they
// pass through every merge untouched and are never uploaded. Rooms that were
// already on a device when it first signed in start device-only (seedLocalOnly);
// the user ticks the ones to sync. Signing out drops the synced rooms from the
// device (they stay in the account) and keeps the device-only ones (dropSynced).

export const ROOMS_KEY = "ay.rooms";
export const REMOVED_KEY = "ay.roomsRemoved";
export const ROOM_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const CODEHOST_HOST = "codehost";

export const SYNC_FILE = "ay-rooms.json";
export const KDF_ITERATIONS = 600_000;
const BLOB_VERSION = 1;

/** True for a room entry that belongs in the synced list. */
export const isSyncable = (r) =>
  !!r && typeof r.token === "string" && !!r.token && r.host !== CODEHOST_HOST && !r.localOnly;

/**
 * Merge two room states. A state is { rooms: {name: {token, host, ts, added}},
 * removed: {name: ts} }. Pure; returns a new state.
 *
 * Per name: of two copies, the newer `added` wins (newer `ts` on a tie), keeping
 * the later `ts` of the two. The room survives a removal only if it was added at
 * or after it (a re-add right after a forget should not lose to a clock tie). An
 * entry with no `added` (saved before sync existed) counts as added at 0, so an
 * explicit forget always beats it. Rooms and removals older than the TTL are
 * dropped. Non-syncable local rooms (codehost) pass through from `local`.
 */
export function mergeRooms(local, remote, now) {
  const rooms = {};
  const removed = {};
  const fresh = (ts) => typeof ts === "number" && now - ts <= ROOM_TTL_MS;
  const lr = local?.rooms || {};
  const rr = remote?.rooms || {};
  const names = new Set([
    ...Object.keys(lr),
    ...Object.keys(rr),
    ...Object.keys(local?.removed || {}),
    ...Object.keys(remote?.removed || {}),
  ]);
  for (const name of names) {
    const l = lr[name];
    if (l && !isSyncable(l)) {
      // codehost, device-only and malformed entries are this device's business
      // only. A room just switched to device-only still carries the removal that
      // tells the account (and so other devices) to let go of it.
      rooms[name] = l;
      const left = Math.max(local?.removed?.[name] || 0, remote?.removed?.[name] || 0);
      if (l.localOnly && left && fresh(left)) removed[name] = left;
      continue;
    }
    const r = isSyncable(rr[name]) ? rr[name] : undefined;
    const room = !l || !r ? l || r : pick(l, r);
    const ts = Math.max(l?.ts || 0, r?.ts || 0);
    const gone = Math.max(local?.removed?.[name] || 0, remote?.removed?.[name] || 0);
    if (room && fresh(ts) && added(room) >= gone) {
      rooms[name] = { token: room.token, host: room.host, ts, added: added(room) };
    } else if (gone && fresh(gone)) {
      removed[name] = gone;
    }
  }
  return { rooms, removed };
}

const added = (x) => x?.added || 0;

/** Stop syncing `name`: keep it here, and let the account (so other devices) forget it. */
export function markDeviceOnly(state, name, now) {
  const r = state.rooms?.[name];
  if (!r || !isSyncable(r)) return state;
  return {
    rooms: { ...state.rooms, [name]: { ...r, localOnly: true } },
    removed: { ...state.removed, [name]: now },
  };
}

/** Sync `name` again. `added` is bumped so it outranks the removal made when it was switched off. */
export function markSynced(state, name, now) {
  const r = state.rooms?.[name];
  if (!r || r.host === CODEHOST_HOST || !r.token) return state;
  const { localOnly: _off, ...rest } = r;
  return { rooms: { ...state.rooms, [name]: { ...rest, added: now } }, removed: state.removed };
}

/** First sign-in on a device: what is already here stays here until the user ticks it. */
export function seedLocalOnly(state) {
  const rooms = {};
  for (const [n, r] of Object.entries(state.rooms || {}))
    rooms[n] = isSyncable(r) ? { ...r, localOnly: true } : r;
  return { rooms, removed: state.removed || {} };
}

/** Sign-out: synced rooms leave this device (they stay in the account); the rest stay. */
export function dropSynced(state) {
  const rooms = {};
  for (const [n, r] of Object.entries(state.rooms || {})) if (!isSyncable(r)) rooms[n] = r;
  return { rooms, removed: {} };
}

/** Of two copies of one room: the newer `added`, else the newer `ts`. */
function pick(a, b) {
  if (added(a) !== added(b)) return added(a) > added(b) ? a : b;
  return (b.ts || 0) > (a.ts || 0) ? b : a;
}

/** The part of a state that is uploaded: syncable rooms plus removals. */
export function syncPayload(state) {
  const rooms = {};
  for (const [name, r] of Object.entries(state.rooms || {}))
    if (isSyncable(r))
      rooms[name] = { token: r.token, host: r.host, ts: r.ts, added: r.added || 0 };
  return { rooms, removed: { ...state.removed } };
}

/** Same rooms (name, token, host, ts, added) and removals in both states. */
export function sameState(a, b) {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}
function canon(s) {
  const sort = (o) =>
    Object.fromEntries(Object.entries(o || {}).sort(([x], [y]) => (x < y ? -1 : 1)));
  return { rooms: sort(s?.rooms), removed: sort(s?.removed) };
}

// ── encryption ────────────────────────────────────────────────────────────────

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** A non-extractable AES-GCM key from the passphrase and the blob's salt. */
export async function deriveKey(
  passphrase,
  salt,
  iterations = KDF_ITERATIONS,
  subtle = crypto.subtle,
) {
  const base = await subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export const newSalt = (rand = crypto) => rand.getRandomValues(new Uint8Array(16));

/** The plaintext header of a blob: what a device needs to derive the key. */
export function blobHeader(blob) {
  if (!blob || blob.v !== BLOB_VERSION || !blob.salt || !blob.iterations)
    throw new Error("not an agent-yes rooms sync file");
  return { salt: unb64(blob.salt), iterations: blob.iterations };
}

/** Encrypt a state. The header is bound as AES-GCM additional data. */
export async function sealRooms(state, key, salt, iterations = KDF_ITERATIONS, c = crypto) {
  const head = { v: BLOB_VERSION, salt: b64(salt), iterations };
  const iv = c.getRandomValues(new Uint8Array(12));
  const ct = await c.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(JSON.stringify(head)) },
    key,
    new TextEncoder().encode(JSON.stringify(syncPayload(state))),
  );
  return { ...head, iv: b64(iv), ct: b64(ct) };
}

export class WrongPassphrase extends Error {
  constructor() {
    super("wrong sync passphrase");
  }
}

/** Decrypt a blob; throws WrongPassphrase when the key does not open it. */
export async function openRooms(blob, key, subtle = crypto.subtle) {
  const head = { v: blob.v, salt: blob.salt, iterations: blob.iterations };
  let pt;
  try {
    pt = await subtle.decrypt(
      {
        name: "AES-GCM",
        iv: unb64(blob.iv),
        additionalData: new TextEncoder().encode(JSON.stringify(head)),
      },
      key,
      unb64(blob.ct),
    );
  } catch {
    throw new WrongPassphrase();
  }
  const s = JSON.parse(new TextDecoder().decode(pt));
  return { rooms: s.rooms || {}, removed: s.removed || {} };
}

// ── Google Drive app folder ──────────────────────────────────────────────────

const DRIVE = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

/** Read and write the one sync file in the user's Drive app folder. */
export function driveStore(accessToken, fetchImpl = fetch) {
  const auth = { Authorization: `Bearer ${accessToken}` };
  const check = async (r, what) => {
    if (!r.ok) throw new Error(`Drive ${what} failed: HTTP ${r.status}`);
    return r;
  };
  return {
    /** { id, blob } or null when the file does not exist yet. */
    async read() {
      const q = encodeURIComponent(`name='${SYNC_FILE}'`);
      const list = await check(
        await fetchImpl(`${DRIVE}?spaces=appDataFolder&q=${q}&fields=files(id)`, { headers: auth }),
        "list",
      );
      const id = (await list.json()).files?.[0]?.id;
      if (!id) return null;
      const got = await check(
        await fetchImpl(`${DRIVE}/${id}?alt=media`, { headers: auth }),
        "read",
      );
      return { id, blob: await got.json() };
    },
    /** Create the file (id null) or overwrite it. Returns the file id. */
    async write(id, blob) {
      const body = JSON.stringify(blob);
      if (id) {
        await check(
          await fetchImpl(`${UPLOAD}/${id}?uploadType=media`, {
            method: "PATCH",
            headers: { ...auth, "Content-Type": "application/json" },
            body,
          }),
          "write",
        );
        return id;
      }
      const boundary = "ay" + Math.random().toString(36).slice(2);
      const meta = JSON.stringify({ name: SYNC_FILE, parents: ["appDataFolder"] });
      const multipart =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
        `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
      const r = await check(
        await fetchImpl(`${UPLOAD}?uploadType=multipart&fields=id`, {
          method: "POST",
          headers: { ...auth, "Content-Type": `multipart/related; boundary=${boundary}` },
          body: multipart,
        }),
        "create",
      );
      return (await r.json()).id;
    },
  };
}

// ── one sync round ───────────────────────────────────────────────────────────

/**
 * Pull, merge and push once. Deps:
 *   store        driveStore(...)
 *   local        the current local state { rooms, removed }
 *   keyFor(salt, iterations)  → CryptoKey for an existing file's header
 *                               (cached per device; asks for the passphrase)
 *   newKey()     → { key, salt, iterations } for a first upload
 *   now          clock (ms)
 * Returns { state, uploaded }. The caller writes `state` back to localStorage.
 *
 * Two devices syncing at the same moment can overwrite each other's upload. No
 * change is lost: each device keeps its own state and merges it in again on its
 * next sync, and merge is order-independent.
 */
export async function syncOnce({ store, local, keyFor, newKey, now }) {
  const file = await store.read();
  if (!file) {
    const { key, salt, iterations } = await newKey();
    const state = mergeRooms(local, null, now);
    await store.write(null, await sealRooms(state, key, salt, iterations));
    return { state, uploaded: true };
  }
  const { salt, iterations } = blobHeader(file.blob);
  const key = await keyFor(salt, iterations);
  const remote = await openRooms(file.blob, key);
  const state = mergeRooms(local, remote, now);
  const uploaded = !sameState(syncPayload(state), remote);
  if (uploaded) await store.write(file.id, await sealRooms(state, key, salt, iterations));
  return { state, uploaded };
}
