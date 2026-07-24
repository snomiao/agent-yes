import { describe, expect, it } from "vitest";
import { formatHlc } from "./hlc.ts";
import { makeOp, type Op, type Role } from "./op.ts";
import { haveVector, maxHlc, mergeOps, opsMissing, renderThread, sortOps } from "./store.ts";

// Build an op with an explicit (ms, ctr) HLC for deterministic ordering.
function op(
  author: string,
  ms: number,
  kind: Op["kind"],
  body?: string,
  ref?: string,
  role: Role = "human",
): Op {
  return makeOp({ author, name: author, role, hlc: formatHlc(ms, 0, author), kind, body, ref });
}

describe("mergeOps", () => {
  const a = op("a", 1, "msg", "one");
  const b = op("b", 2, "msg", "two");
  const c = op("c", 3, "msg", "three");

  it("is a union deduped by id", () => {
    const { merged, added } = mergeOps([a], [a, b]);
    expect(merged.map((o) => o.id)).toEqual([a.id, b.id]);
    expect(added.map((o) => o.id)).toEqual([b.id]); // only genuinely new
  });

  it("is commutative and idempotent (convergence)", () => {
    const x = mergeOps(mergeOps([], [a, b]).merged, [c]).merged;
    const y = mergeOps(mergeOps([], [c, b]).merged, [a]).merged;
    expect(x.map((o) => o.id)).toEqual(y.map((o) => o.id));
    // merging again adds nothing
    expect(mergeOps(x, [a, b, c]).added).toEqual([]);
  });

  it("reports the running max HLC", () => {
    expect(maxHlc([])).toBeNull();
    expect(maxHlc([a, c, b])).toBe(c.hlc);
  });

  it("sorts by HLC then id", () => {
    expect(sortOps([c, a, b]).map((o) => o.id)).toEqual([a.id, b.id, c.id]);
  });

  it("breaks a same-HLC tie deterministically by id", () => {
    // two authors that collide on (ms, ctr) — the id (author@hlc) decides order
    const x = makeOp({
      author: "z",
      name: "z",
      role: "human",
      hlc: formatHlc(9, 0, "z"),
      kind: "msg",
      body: "x",
    });
    const y = makeOp({
      author: "a",
      name: "a",
      role: "human",
      hlc: formatHlc(9, 0, "a"),
      kind: "msg",
      body: "y",
    });
    expect(sortOps([x, y]).map((o) => o.author)).toEqual(["a", "z"]);
    expect(sortOps([y, x]).map((o) => o.author)).toEqual(["a", "z"]);
  });
});

describe("renderThread", () => {
  it("renders base messages in HLC order", () => {
    const msgs = renderThread([op("b", 2, "msg", "two"), op("a", 1, "msg", "one")]);
    expect(msgs.map((m) => m.text)).toEqual(["one", "two"]);
  });

  it("applies the latest edit (last-writer-wins)", () => {
    const m = op("a", 1, "msg", "orig");
    const e1 = op("a", 2, "edit", "v2", m.id);
    const e2 = op("a", 3, "edit", "v3", m.id);
    const [r] = renderThread([m, e2, e1]);
    expect(r!.text).toBe("v3");
    expect(r!.amendedHlc).toBe(e2.hlc);
  });

  it("hides a deleted message, and an edit after a delete revives it", () => {
    const m = op("a", 1, "msg", "hi");
    expect(renderThread([m, op("a", 2, "delete", undefined, m.id)])[0]!).toMatchObject({
      deleted: true,
      text: "",
    });
    // delete then a newer edit → revived
    const revived = renderThread([
      m,
      op("a", 2, "delete", undefined, m.id),
      op("a", 3, "edit", "back", m.id),
    ])[0]!;
    expect(revived).toMatchObject({ deleted: false, text: "back" });
  });

  it("groups reactions by emoji into distinct authors", () => {
    const m = op("a", 1, "msg", "hi");
    const r = renderThread([
      m,
      op("b", 2, "reaction", "👍", m.id),
      op("c", 3, "reaction", "👍", m.id),
      op("b", 4, "reaction", "👍", m.id), // duplicate author → deduped
      op("b", 5, "reaction", "🎉", m.id),
    ])[0]!;
    expect(r.reactions).toEqual([
      { emoji: "👍", by: ["b", "c"] },
      { emoji: "🎉", by: ["b"] },
    ]);
  });

  it("ignores amendments whose target op is absent", () => {
    expect(renderThread([op("a", 2, "edit", "x", "missing@id")])).toEqual([]);
  });

  it("ignores a reaction with an empty body", () => {
    const m = op("a", 1, "msg", "hi");
    const [r] = renderThread([m, op("b", 2, "reaction", "", m.id)]);
    expect(r!.reactions).toEqual([]);
  });
});

describe("anti-entropy sync", () => {
  const local = [op("a", 1, "msg", "a1"), op("a", 2, "msg", "a2"), op("b", 5, "msg", "b1")];

  it("summarizes what a replica holds per author", () => {
    expect(haveVector(local)).toEqual({ a: formatHlc(2, 0, "a"), b: formatHlc(5, 0, "b") });
    // keeps the max even when an older op for an author appears after a newer one
    const outOfOrder = [op("a", 2, "msg", "a2"), op("a", 1, "msg", "a1")];
    expect(haveVector(outOfOrder)).toEqual({ a: formatHlc(2, 0, "a") });
  });

  it("computes exactly the ops a peer is missing", () => {
    // peer has a up to ms=1 and nothing from b
    const remoteHave = { a: formatHlc(1, 0, "a") };
    const missing = opsMissing(local, remoteHave);
    expect(missing.map((o) => o.body)).toEqual(["a2", "b1"]);
  });

  it("sends nothing when the peer is already caught up", () => {
    expect(opsMissing(local, haveVector(local))).toEqual([]);
  });
});
