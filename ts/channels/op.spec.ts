import { describe, expect, it } from "vitest";
import { isValidOp, makeOp, opId } from "./op.ts";

const base = { author: "a1", name: "taku", role: "human" as const, hlc: "h1" };

describe("op", () => {
  it("derives a stable id from author + hlc", () => {
    expect(opId("a1", "h1")).toBe("a1@h1");
    expect(makeOp({ ...base, kind: "msg", body: "hi" }).id).toBe("a1@h1");
  });

  it("drops empty optional fields", () => {
    const op = makeOp({ ...base, kind: "msg", body: "hi" });
    expect(op).not.toHaveProperty("ref");
    const del = makeOp({ ...base, kind: "delete", ref: "a1@h0" });
    expect(del).not.toHaveProperty("body");
    expect(del.ref).toBe("a1@h0");
  });

  it("keeps an empty-string body (a cleared edit) but not undefined", () => {
    expect(makeOp({ ...base, kind: "edit", body: "", ref: "x" }).body).toBe("");
  });

  it("validates a well-formed op", () => {
    expect(isValidOp(makeOp({ ...base, kind: "msg", body: "hi" }))).toBe(true);
    expect(isValidOp(makeOp({ ...base, kind: "reaction", body: "👍", ref: "x" }))).toBe(true);
  });

  it("rejects malformed ops (fail-closed)", () => {
    expect(isValidOp(null)).toBe(false);
    expect(isValidOp({ ...base, id: "a1@h1", kind: "nope", name: "x" })).toBe(false);
    expect(isValidOp({ ...base, id: "a1@h1", kind: "msg", name: "x", role: "robot" })).toBe(false);
    // id must equal author@hlc
    expect(isValidOp({ ...base, id: "forged", kind: "msg", name: "x" })).toBe(false);
    // amendments must carry a ref
    expect(isValidOp({ ...base, id: "a1@h1", kind: "edit", name: "x", body: "z" })).toBe(false);
    // wrong field types
    expect(isValidOp({ ...base, id: "a1@h1", kind: "msg", name: 5 })).toBe(false);
    expect(
      isValidOp({
        author: "a1",
        hlc: "h1",
        id: "a1@h1",
        kind: "msg",
        name: "x",
        role: "human",
        body: 1,
      }),
    ).toBe(false);
    // ref of the wrong type
    expect(isValidOp({ ...base, id: "a1@h1", kind: "edit", name: "x", body: "z", ref: 9 })).toBe(
      false,
    );
    // sig of the wrong type is rejected; a string sig is accepted
    expect(isValidOp({ ...base, id: "a1@h1", kind: "msg", name: "x", sig: 1 })).toBe(false);
    expect(
      isValidOp({ ...base, id: "a1@h1", kind: "msg", name: "x", body: "hi", sig: "deadbeef" }),
    ).toBe(true);
    // reaction/delete without a ref also fail-closed
    expect(isValidOp({ ...base, id: "a1@h1", kind: "reaction", name: "x", body: "👍" })).toBe(
      false,
    );
    expect(isValidOp({ ...base, id: "a1@h1", kind: "delete", name: "x" })).toBe(false);
    // missing/blank required fields
    expect(isValidOp({ ...base, id: "a1@h1", kind: "msg", name: "x", author: "" })).toBe(false);
    expect(
      isValidOp({ id: "@h1", kind: "msg", name: "x", role: "human", author: "", hlc: "h1" }),
    ).toBe(false);
  });
});
