// Browser glue for "Sync my rooms", shared by the console (/w/) and rgui (/r/).
// The rules (merge, encryption, the Drive file) live in room-sync.js; this file
// adds the parts that need a browser: the better-auth session on agent-yes.com,
// the per-device key cache in IndexedDB, and localStorage.
//
// The derived key is stored as a non-extractable CryptoKey, so the passphrase
// itself is never stored and the key cannot be read back out by page script.
// It is keyed by the sync file's salt: "Reset sync" (a new salt) or another
// account's file simply asks for the passphrase again.

import {
  KDF_ITERATIONS,
  REMOVED_KEY,
  ROOMS_KEY,
  WrongPassphrase,
  deriveKey,
  driveStore,
  mergeRooms,
  newSalt,
  sealRooms,
  syncOnce,
} from "./room-sync.js";

const AUTH = "/_ay/auth";
const IDB_NAME = "ay-room-sync";
const IDB_STORE = "keys";

export class NeedPassphrase extends Error {
  /** @param {boolean} first  true when no sync file exists yet (choose one) */
  constructor(first) {
    super(first ? "choose a sync passphrase" : "enter your sync passphrase");
    this.first = first;
  }
}
export { WrongPassphrase };

const saltId = (salt) => btoa(String.fromCharCode(...salt));

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, mode);
      const req = fn(tx.objectStore(IDB_STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
const cachedKey = (id) => idbDo("readonly", (s) => s.get(id)).catch(() => undefined);
const cacheKey = (id, key) => idbDo("readwrite", (s) => s.put(key, id)).catch(() => {});
const clearKeys = () => idbDo("readwrite", (s) => s.clear()).catch(() => {});

function readLocal() {
  const parse = (k) => {
    try {
      return JSON.parse(localStorage.getItem(k) || "{}") || {};
    } catch {
      return {};
    }
  };
  return { rooms: parse(ROOMS_KEY), removed: parse(REMOVED_KEY) };
}
function writeLocal(state) {
  localStorage.setItem(ROOMS_KEY, JSON.stringify(state.rooms));
  localStorage.setItem(REMOVED_KEY, JSON.stringify(state.removed));
}

/** Record an explicit "Forget" so it syncs as a delete (codehost rooms stay local). */
export function recordRemoval(name, host, now = Date.now()) {
  if (host === "codehost") return;
  try {
    const r = JSON.parse(localStorage.getItem(REMOVED_KEY) || "{}") || {};
    r[name] = now;
    localStorage.setItem(REMOVED_KEY, JSON.stringify(r));
  } catch {}
}

async function authJson(path, init) {
  const r = await fetch(AUTH + path, {
    credentials: "same-origin",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const isJson = (r.headers.get("content-type") || "").includes("application/json");
  if (!r.ok || !isJson) {
    const err = new Error(`${path}: HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

/**
 * The sync controller. `onApply(before, after)` runs after a sync changed the
 * local list, so the UI can connect new rooms and drop forgotten ones.
 * State for the UI: { available, user, busy, error, needs, last }.
 */
export function createRoomSync({ onApply = () => {}, onState = () => {} } = {}) {
  const st = { available: false, user: null, busy: false, error: "", needs: null, last: 0 };
  const emit = () => onState({ ...st });
  let timer = null;
  let again = false; // a change arrived while a round was running

  async function refresh() {
    try {
      // Sync needs Google specifically (the Drive app folder); a deployment with
      // only GitHub sign-in (or none, or a self-hosted domain) shows no sync UI.
      const { providers } = await authJson("/providers", { method: "GET" });
      if (!providers?.includes("google")) throw new Error("no Google sign-in here");
      const s = await authJson("/get-session", { method: "GET" });
      st.available = true;
      st.user = s?.user ? { email: s.user.email, name: s.user.name } : null;
    } catch {
      // 503 (not configured), 404 (not agent-yes.com, e.g. a local `ay serve`
      // console) or offline: no sync controls at all.
      st.available = false;
      st.user = null;
    }
    emit();
    return st;
  }

  async function accessToken() {
    const accounts = await authJson("/list-accounts", { method: "GET" });
    const google = (accounts || []).find((a) => a.providerId === "google");
    if (!google) throw new Error("no Google account linked");
    const t = await authJson("/get-access-token", {
      method: "POST",
      body: JSON.stringify({ accountId: google.id }),
    });
    if (!t?.accessToken) throw new Error("Google did not return an access token");
    return t.accessToken;
  }

  /** One sync. `passphrase` is only needed when this device has no key yet. */
  async function run(passphrase) {
    if (!st.user) return;
    if (st.busy) {
      // Never drop a request: a forget made during a round must still upload.
      again = true;
      return;
    }
    st.busy = true;
    st.error = "";
    emit();
    try {
      const store = driveStore(await accessToken());
      const before = readLocal();
      const { state } = await syncOnce({
        store,
        local: before,
        now: Date.now(),
        async keyFor(salt, iterations) {
          const id = saltId(salt);
          const hit = await cachedKey(id);
          if (hit) return hit;
          if (!passphrase) throw new NeedPassphrase(false);
          const key = await deriveKey(passphrase, salt, iterations);
          // Cached right away; if it does not open the file (openRooms runs
          // next), the WrongPassphrase catch below evicts it.
          await cacheKey(id, key);
          return key;
        },
        async newKey() {
          if (!passphrase) throw new NeedPassphrase(true);
          const salt = newSalt();
          const key = await deriveKey(passphrase, salt, KDF_ITERATIONS);
          await cacheKey(saltId(salt), key);
          return { key, salt, iterations: KDF_ITERATIONS };
        },
      });
      // Merge again with a fresh read: a room saved or forgotten while the round
      // was in flight must not be lost (it is uploaded on the next round).
      const after = mergeRooms(readLocal(), state, Date.now());
      writeLocal(after);
      st.needs = null;
      st.last = Date.now();
      onApply(before, after);
    } catch (e) {
      if (e instanceof NeedPassphrase) st.needs = e.first ? "new" : "unlock";
      else if (e instanceof WrongPassphrase) {
        await clearKeys();
        st.needs = "unlock";
        st.error = "wrong passphrase";
      } else st.error = String(e?.message || e);
    } finally {
      st.busy = false;
      emit();
      if (again && !st.needs) {
        again = false;
        setTimeout(() => run(), 0);
      }
    }
  }

  return {
    state: () => ({ ...st }),
    refresh,
    run,
    /** Coalesce bursts of local changes (a share link opened, a forget) into one sync. */
    schedule(delay = 2000) {
      if (!st.user) return;
      clearTimeout(timer);
      timer = setTimeout(() => run(), delay);
    },
    async signIn() {
      const r = await authJson("/sign-in/social", {
        method: "POST",
        body: JSON.stringify({
          provider: "google",
          callbackURL: location.pathname + location.search,
          // A cancelled or failed Google sign-in lands back here, not on
          // better-auth's bare error page.
          errorCallbackURL: location.pathname + location.search,
        }),
      });
      if (r?.url) location.href = r.url;
    },
    async signOut() {
      await authJson("/sign-out", { method: "POST", body: "{}" }).catch(() => {});
      await clearKeys();
      st.user = null;
      st.needs = null;
      emit();
    },
    /**
     * Forgotten passphrase: replace the synced list with this device's list,
     * encrypted under a new passphrase. Other devices then ask for the new one.
     */
    async reset(passphrase) {
      if (!st.user || !passphrase) return;
      st.busy = true;
      emit();
      try {
        await clearKeys();
        const store = driveStore(await accessToken());
        const file = await store.read();
        const salt = newSalt();
        const key = await deriveKey(passphrase, salt, KDF_ITERATIONS);
        const state = mergeRooms(readLocal(), null, Date.now());
        await store.write(file?.id ?? null, await sealRooms(state, key, salt, KDF_ITERATIONS));
        await cacheKey(saltId(salt), key);
        st.needs = null;
        st.error = "";
        st.last = Date.now();
      } catch (e) {
        st.error = String(e?.message || e);
      } finally {
        st.busy = false;
        emit();
      }
    },
    /** Forget the passphrase on this device only (the synced list is untouched). */
    lock: clearKeys,
  };
}
