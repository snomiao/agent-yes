import { describe, expect, it } from "vitest";
import { isTermToken, mintTermToken, verifyTermToken } from "./termToken.ts";

const MASTER = "master-token-abc123";
const now = 1_000_000; // fixed epoch seconds for deterministic exp checks

describe("termToken", () => {
  it("round-trips a valid read-only token", () => {
    const tok = mintTermToken(MASTER, { pid: "4242", canSend: false, exp: now + 900 });
    expect(isTermToken(tok)).toBe(true);
    const scope = verifyTermToken(MASTER, tok, now);
    expect(scope).toEqual({ pid: "4242", canSend: false, caps: ["tail", "size"], exp: now + 900 });
  });

  it("round-trips an interactive token (canSend true → send/resize caps)", () => {
    const tok = mintTermToken(MASTER, { pid: "7", canSend: true, exp: now + 60 });
    const scope = verifyTermToken(MASTER, tok, now);
    expect(scope?.canSend).toBe(true);
    expect(scope?.caps).toEqual(["tail", "size", "send", "resize"]);
  });

  it("carries an explicit caps array (widget read/screenshot)", () => {
    const tok = mintTermToken(MASTER, { pid: "v_ab12", caps: ["read", "screenshot"], exp: now + 60 });
    const scope = verifyTermToken(MASTER, tok, now);
    expect(scope?.caps).toEqual(["read", "screenshot"]);
    expect(scope?.canSend).toBe(false); // no "send" cap
    expect(scope?.pid).toBe("v_ab12");
  });

  it("verifies a legacy {p,w,x} token (pre-caps format) into derived caps", () => {
    // hand-build a legacy payload to prove backward-compat with live phase-2 tokens
    const legacy = Buffer.from(JSON.stringify({ p: "9", w: 1, x: now + 60 })).toString("base64url");
    const body = `ayt1.${legacy}`;
    const { createHmac, createHash } = require("crypto");
    const key = createHash("sha256").update("ay/term/token/v1\n" + MASTER).digest();
    const sig = createHmac("sha256", key).update(body).digest().toString("base64url");
    const scope = verifyTermToken(MASTER, `${body}.${sig}`, now);
    expect(scope?.pid).toBe("9");
    expect(scope?.caps).toEqual(["tail", "size", "send", "resize"]);
  });

  it("rejects a token signed with a different master (forgery)", () => {
    const tok = mintTermToken(MASTER, { pid: "7", canSend: true, exp: now + 60 });
    expect(verifyTermToken("other-master", tok, now)).toBeNull();
  });

  it("rejects an expired token", () => {
    const tok = mintTermToken(MASTER, { pid: "7", canSend: false, exp: now - 1 });
    expect(verifyTermToken(MASTER, tok, now)).toBeNull();
  });

  it("rejects a tampered payload (pid swap) — signature no longer matches", () => {
    const tok = mintTermToken(MASTER, { pid: "7", canSend: false, exp: now + 60 });
    const [prefix, , sig] = tok.split(".");
    const evil = Buffer.from(JSON.stringify({ p: "9999", w: 1, x: now + 60 })).toString("base64url");
    expect(verifyTermToken(MASTER, `${prefix}.${evil}.${sig}`, now)).toBeNull();
  });

  it("rejects the master token itself and other non-scoped strings", () => {
    expect(isTermToken(MASTER)).toBe(false);
    expect(verifyTermToken(MASTER, MASTER, now)).toBeNull();
    expect(verifyTermToken(MASTER, "ayt1.only-two-parts", now)).toBeNull();
    expect(verifyTermToken(MASTER, "", now)).toBeNull();
    expect(verifyTermToken(MASTER, undefined, now)).toBeNull();
  });
});
