// Unit tests for "Sync my rooms" (lab/ui/room-sync.js): merge rules, the
// encrypted blob format, the Drive app-folder client and one full sync round.
import { describe, expect, it, vi } from "vitest";
import {
  ROOM_TTL_MS,
  SYNC_FILE,
  WrongPassphrase,
  blobHeader,
  deriveKey,
  driveStore,
  dropSynced,
  markDeviceOnly,
  markSynced,
  mergeRooms,
  newSalt,
  openRooms,
  sealRooms,
  seedLocalOnly,
  syncOnce,
  syncPayload,
} from "../../lab/ui/room-sync.js";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
// A room last used at `ts` and added at `added` (default: added when last used).
const room = (token: string, ts: number, added = ts, host = "s.agent-yes.com") => ({
  token,
  host,
  ts,
  added,
});
// Few iterations keep the tests fast; the real default is KDF_ITERATIONS.
const ITER = 1000;

describe("mergeRooms", () => {
  it("unions rooms from both sides and keeps the newer copy of a shared name", () => {
    const local = {
      rooms: { alpha: room("a1", NOW - 5), beta: room("b-old", NOW - 9) },
      removed: {},
    };
    const remote = {
      rooms: { beta: room("b-new", NOW - 1), gamma: room("g", NOW - 3) },
      removed: {},
    };
    expect(mergeRooms(local, remote, NOW)).toEqual({
      rooms: {
        alpha: room("a1", NOW - 5),
        beta: room("b-new", NOW - 1),
        gamma: room("g", NOW - 3),
      },
      removed: {},
    });
  });

  it("a forget on one device removes the room everywhere", () => {
    const local = { rooms: { alpha: room("a", NOW - 10) }, removed: {} };
    const remote = { rooms: {}, removed: { alpha: NOW - 2 } };
    expect(mergeRooms(local, remote, NOW)).toEqual({ rooms: {}, removed: { alpha: NOW - 2 } });
  });

  it("a forget beats another device's later reconnect of the same room", () => {
    // The phone reloaded after the laptop's forget: its boot reconnect moved ts
    // past the removal, but the room was added long before it.
    const phone = { rooms: { alpha: room("a", NOW - 1, NOW - 50) }, removed: {} };
    const laptop = { rooms: {}, removed: { alpha: NOW - 10 } };
    expect(mergeRooms(phone, laptop, NOW)).toEqual({ rooms: {}, removed: { alpha: NOW - 10 } });
  });

  it("a forget beats a room saved before sync existed (no added time)", () => {
    const legacy = {
      rooms: { alpha: { token: "a", host: "s.agent-yes.com", ts: NOW - 1 } },
      removed: {},
    };
    expect(mergeRooms(legacy, { rooms: {}, removed: { alpha: NOW - 10 } }, NOW).rooms).toEqual({});
  });

  it("between two tokens for one name the newer add wins, keeping the latest use", () => {
    const local = { rooms: { alpha: room("old-token", NOW - 1, NOW - 100) }, removed: {} };
    const remote = { rooms: { alpha: room("new-token", NOW - 20, NOW - 20) }, removed: {} };
    expect(mergeRooms(local, remote, NOW).rooms.alpha).toEqual(
      room("new-token", NOW - 1, NOW - 20),
    );
  });

  it("a room saved after the forget comes back, and wins a tie", () => {
    const remote = { rooms: {}, removed: { alpha: NOW - 2 } };
    expect(
      mergeRooms({ rooms: { alpha: room("a", NOW - 1) }, removed: {} }, remote, NOW).rooms,
    ).toEqual({
      alpha: room("a", NOW - 1),
    });
    expect(
      mergeRooms({ rooms: { alpha: room("a", NOW - 2) }, removed: {} }, remote, NOW).rooms,
    ).toEqual({
      alpha: room("a", NOW - 2),
    });
  });

  it("drops expired rooms without writing a removal, so expiry never deletes elsewhere", () => {
    const old = NOW - ROOM_TTL_MS - DAY;
    const out = mergeRooms({ rooms: { stale: room("s", old) }, removed: {} }, null, NOW);
    expect(out).toEqual({ rooms: {}, removed: {} });
  });

  it("forgets removal records once they are past the TTL", () => {
    const out = mergeRooms({ rooms: {}, removed: { alpha: NOW - ROOM_TTL_MS - 1 } }, null, NOW);
    expect(out.removed).toEqual({});
  });

  it("keeps codehost rooms local: never uploaded, never replaced by a remote copy", () => {
    const ch = { token: "ch-token", host: "codehost", ts: NOW - 5 };
    const local = { rooms: { fleet: ch }, removed: {} };
    const remote = { rooms: { fleet: room("other", NOW) }, removed: {} };
    const out = mergeRooms(local, remote, NOW);
    expect(out.rooms.fleet).toEqual(ch);
    expect(syncPayload(out).rooms).toEqual({});
  });

  it("ignores a malformed remote entry", () => {
    const remote = { rooms: { bad: { host: "s.agent-yes.com", ts: NOW } }, removed: {} };
    expect(mergeRooms({ rooms: {}, removed: {} }, remote as never, NOW).rooms).toEqual({});
  });

  it("does not cap the number of rooms", () => {
    const rooms = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`r${i}`, room(`t${i}`, NOW - i)]),
    );
    expect(Object.keys(mergeRooms({ rooms, removed: {} }, null, NOW).rooms)).toHaveLength(60);
  });
});

describe("encrypted blob", () => {
  it("round-trips with the right passphrase and keeps tokens out of the file", async () => {
    const salt = newSalt();
    const key = await deriveKey("correct horse", salt, ITER);
    const state = { rooms: { alpha: room("secret-token-1", NOW) }, removed: { beta: NOW - 1 } };
    const blob = await sealRooms(state, key, salt, ITER);
    expect(JSON.stringify(blob)).not.toContain("secret-token-1");
    expect(JSON.stringify(blob)).not.toContain("alpha");
    const head = blobHeader(blob);
    expect(head.iterations).toBe(ITER);
    expect([...head.salt]).toEqual([...salt]);
    const again = await deriveKey("correct horse", head.salt, head.iterations);
    expect(await openRooms(blob, again)).toEqual(state);
  });

  it("rejects a wrong passphrase", async () => {
    const salt = newSalt();
    const blob = await sealRooms(
      { rooms: {}, removed: {} },
      await deriveKey("right", salt, ITER),
      salt,
      ITER,
    );
    await expect(openRooms(blob, await deriveKey("wrong", salt, ITER))).rejects.toBeInstanceOf(
      WrongPassphrase,
    );
  });

  it("rejects a blob whose header was changed (it is bound as additional data)", async () => {
    const salt = newSalt();
    const key = await deriveKey("pw", salt, ITER);
    const blob = await sealRooms({ rooms: {}, removed: {} }, key, salt, ITER);
    await expect(openRooms({ ...blob, iterations: ITER + 1 }, key)).rejects.toBeInstanceOf(
      WrongPassphrase,
    );
  });

  it("refuses to read a file that is not a sync blob", () => {
    expect(() => blobHeader({ hello: "world" })).toThrow(/not an agent-yes/);
  });
});

/** An in-memory Drive app folder that speaks the four requests driveStore makes. */
function fakeDrive() {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const f = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method || "GET";
    calls.push(`${method} ${url.replace(/\?.*/, "")}`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    if (method === "GET" && url.includes("spaces=appDataFolder")) {
      expect(decodeURIComponent(url)).toContain(`name='${SYNC_FILE}'`);
      return Response.json({ files: [...files.keys()].map((id) => ({ id })) });
    }
    if (method === "GET" && url.includes("alt=media")) {
      const id = url.split("/").pop()!.split("?")[0]!;
      return new Response(files.get(id));
    }
    if (method === "POST") {
      const body = String(init.body);
      expect(body).toContain('"parents":["appDataFolder"]');
      const json = body.split("\r\n\r\n")[2]!.split("\r\n--")[0]!;
      files.set("file-1", json);
      return Response.json({ id: "file-1" });
    }
    if (method === "PATCH") {
      const id = url.split("/").pop()!.split("?")[0]!;
      files.set(id, String(init.body));
      return new Response("{}");
    }
    return new Response("", { status: 400 });
  });
  return { files, calls, fetch: f as unknown as typeof fetch };
}

describe("driveStore", () => {
  it("returns null before the first upload, then reads back what it wrote", async () => {
    const d = fakeDrive();
    const s = driveStore("tok", d.fetch);
    expect(await s.read()).toBeNull();
    const id = await s.write(null, { v: 1, hello: 1 });
    expect(id).toBe("file-1");
    expect(await s.read()).toEqual({ id: "file-1", blob: { v: 1, hello: 1 } });
    await s.write(id, { v: 1, hello: 2 });
    expect((await s.read())!.blob).toEqual({ v: 1, hello: 2 });
  });

  it("reports an HTTP failure", async () => {
    const s = driveStore("tok", (async () => new Response("", { status: 401 })) as never);
    await expect(s.read()).rejects.toThrow(/HTTP 401/);
  });
});

describe("syncOnce", () => {
  async function device(passphrase: string) {
    let cached: CryptoKey | null = null;
    return {
      keyFor: vi.fn(async (salt: Uint8Array, iterations: number) => {
        cached ??= await deriveKey(passphrase, salt, iterations);
        return cached;
      }),
      newKey: vi.fn(async () => {
        const salt = newSalt();
        return { key: await deriveKey(passphrase, salt, ITER), salt, iterations: ITER };
      }),
    };
  }

  it("two devices converge, and a forget on one reaches the other", async () => {
    const d = fakeDrive();
    const store = driveStore("tok", d.fetch);
    const laptop = await device("pw");
    const phone = await device("pw");

    const a = await syncOnce({
      store,
      local: { rooms: { alpha: room("a", NOW - 10) }, removed: {} },
      ...laptop,
      now: NOW,
    });
    expect(a.uploaded).toBe(true);
    expect(laptop.newKey).toHaveBeenCalledTimes(1);

    const b = await syncOnce({
      store,
      local: { rooms: { beta: room("b", NOW - 5) }, removed: {} },
      ...phone,
      now: NOW,
    });
    expect(phone.newKey).not.toHaveBeenCalled();
    expect(Object.keys(b.state.rooms).sort()).toEqual(["alpha", "beta"]);

    // The laptop forgets beta; the phone picks the removal up on its next round.
    const c = await syncOnce({
      store,
      local: { rooms: { alpha: room("a", NOW - 10) }, removed: { beta: NOW - 1 } },
      ...laptop,
      now: NOW,
    });
    expect(Object.keys(c.state.rooms)).toEqual(["alpha"]);
    const e = await syncOnce({ store, local: b.state, ...phone, now: NOW });
    expect(Object.keys(e.state.rooms)).toEqual(["alpha"]);
    expect(e.uploaded).toBe(false);
  });

  it("skips the upload when nothing changed", async () => {
    const d = fakeDrive();
    const store = driveStore("tok", d.fetch);
    const dev = await device("pw");
    const local = { rooms: { alpha: room("a", NOW) }, removed: {} };
    await syncOnce({ store, local, ...dev, now: NOW });
    d.calls.length = 0;
    const r = await syncOnce({ store, local, ...dev, now: NOW });
    expect(r.uploaded).toBe(false);
    expect(d.calls.some((c) => c.startsWith("PATCH"))).toBe(false);
  });

  it("fails with WrongPassphrase and leaves the file alone", async () => {
    const d = fakeDrive();
    const store = driveStore("tok", d.fetch);
    await syncOnce({
      store,
      local: { rooms: {}, removed: {} },
      ...(await device("one")),
      now: NOW,
    });
    const before = d.files.get("file-1");
    await expect(
      syncOnce({
        store,
        local: { rooms: { x: room("x", NOW) }, removed: {} },
        ...(await device("two")),
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(WrongPassphrase);
    expect(d.files.get("file-1")).toBe(before);
  });
});

describe("per-room sync choice", () => {
  const two = { rooms: { alpha: room("t1", NOW), beta: room("t2", NOW) }, removed: {} };

  it("a first sign-in seeds existing rooms as device-only, and they are never uploaded", () => {
    const seeded = seedLocalOnly(two);
    expect(seeded.rooms.alpha.localOnly).toBe(true);
    expect(syncPayload(seeded).rooms).toEqual({});
    // and survive a merge with another device's list untouched
    const merged = mergeRooms(seeded, { rooms: { gamma: room("t3", NOW) }, removed: {} }, NOW);
    expect(Object.keys(merged.rooms).sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(merged.rooms.alpha.localOnly).toBe(true);
  });

  it("seeding leaves codehost rooms alone", () => {
    const s = seedLocalOnly({ rooms: { c: room("t", NOW, NOW, "codehost") }, removed: {} });
    expect(s.rooms.c.localOnly).toBeUndefined();
  });

  it("switching a room to device-only keeps it here and tells the account to forget it", () => {
    const off = markDeviceOnly(two, "alpha", NOW);
    expect(off.rooms.alpha.localOnly).toBe(true);
    expect(off.removed.alpha).toBe(NOW);
    const merged = mergeRooms(off, two, NOW + 1);
    expect(merged.rooms.alpha.localOnly).toBe(true); // still here
    expect(merged.removed.alpha).toBe(NOW); // and the removal is uploaded
    expect(syncPayload(merged).rooms.alpha).toBeUndefined();
    expect(syncPayload(merged).removed.alpha).toBe(NOW);
  });

  it("another device drops a room that was switched to device-only elsewhere", () => {
    const off = mergeRooms(markDeviceOnly(two, "alpha", NOW + 10), null, NOW + 10);
    const other = mergeRooms(two, { rooms: {}, removed: off.removed }, NOW + 11);
    expect(other.rooms.alpha).toBeUndefined();
    expect(other.rooms.beta).toBeDefined();
  });

  it("switching it back to synced outranks the earlier removal", () => {
    const off = markDeviceOnly(two, "alpha", NOW);
    const on = markSynced(off, "alpha", NOW + 5);
    expect(on.rooms.alpha.localOnly).toBeUndefined();
    const merged = mergeRooms(on, { rooms: {}, removed: off.removed }, NOW + 6);
    expect(merged.rooms.alpha.token).toBe("t1");
  });

  it("codehost rooms cannot be switched to synced", () => {
    const c = { rooms: { c: room("t", NOW, NOW, "codehost") }, removed: {} };
    expect(markSynced(c, "c", NOW + 1)).toBe(c);
    expect(markDeviceOnly(c, "c", NOW + 1)).toBe(c);
  });

  it("sign-out drops the synced rooms and keeps device-only and codehost ones", () => {
    const mixed = {
      rooms: {
        synced: room("t1", NOW),
        local: { ...room("t2", NOW), localOnly: true },
        ch: room("t3", NOW, NOW, "codehost"),
      },
      removed: { old: NOW },
    };
    const after = dropSynced(mixed);
    expect(Object.keys(after.rooms).sort()).toEqual(["ch", "local"]);
    expect(after.removed).toEqual({});
  });
});
