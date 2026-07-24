import { describe, expect, it } from "vitest";
import { formatHlc } from "./hlc.ts";
import { makeOp, type Op } from "./op.ts";
import { LocalStorageStore } from "./store.browser.ts";

// Minimal in-memory Storage stand-in (the parts LocalStorageStore uses).
function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

function op(author: string, ms: number, body: string): Op {
  return makeOp({
    author,
    name: author,
    role: "human",
    hlc: formatHlc(ms, 0, author),
    kind: "msg",
    body,
  });
}

describe("LocalStorageStore", () => {
  it("returns [] for an empty channel", async () => {
    const s = new LocalStorageStore("c1", memStorage());
    expect(await s.all()).toEqual([]);
  });

  it("appends, dedups, and reads back sorted (same CRDT as the jsonl backend)", async () => {
    const store = memStorage();
    const s = new LocalStorageStore("c1", store);
    const added = await s.append([op("b", 2, "two"), op("a", 1, "one")]);
    expect(added).toHaveLength(2);
    expect((await s.all()).map((o) => o.body)).toEqual(["one", "two"]);
    // re-append an existing op → nothing new; a second reader converges identically
    expect(await s.append([op("a", 1, "one")])).toEqual([]);
    expect((await new LocalStorageStore("c1", store).all()).map((o) => o.body)).toEqual([
      "one",
      "two",
    ]);
  });

  it("tolerates corrupt storage + drops invalid ops", async () => {
    const store = memStorage();
    store.setItem("ay29ch:c1", "not json");
    const s = new LocalStorageStore("c1", store);
    expect(await s.all()).toEqual([]);
    // @ts-expect-error deliberately malformed
    expect(await s.append([{ id: "x", kind: "msg" }])).toEqual([]);
  });
});
