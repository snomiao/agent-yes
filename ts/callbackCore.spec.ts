import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_EXPIRES_MS,
  buildSnippet,
  frameVisitorMessage,
  mintCapability,
  parseExpires,
  verifyCapability,
} from "./callbackCore.ts";

const SECRET = "test-secret";
const NOW = 1_784_700_000_000;

describe("parseExpires", () => {
  it("parses minutes/hours/days/weeks", () => {
    expect(parseExpires("30m")).toBe(30 * 60_000);
    expect(parseExpires("12h")).toBe(12 * 3_600_000);
    expect(parseExpires("7d")).toBe(7 * 24 * 3_600_000);
    expect(parseExpires("2w")).toBe(14 * 24 * 3_600_000);
    expect(parseExpires(" 1d ")).toBe(24 * 3_600_000);
  });

  it("rejects everything that is not an explicit finite duration", () => {
    for (const bad of ["", "7", "d", "never", "0d", "-1d", "1y", "1.5d", "7 d"]) {
      expect(() => parseExpires(bad), bad).toThrow();
    }
  });

  it("caps at 365d — no effectively-immortal capabilities", () => {
    expect(parseExpires("365d")).toBe(MAX_EXPIRES_MS);
    expect(() => parseExpires("366d")).toThrow(/365d/);
    expect(() => parseExpires("53w")).toThrow(/365d/);
  });
});

describe("mint / verify", () => {
  const payload = { id: "ab12cd34", agent: "4d65a096e983", exp: NOW + 3_600_000 };

  it("round-trips a valid capability", () => {
    const cap = mintCapability(SECRET, payload);
    expect(cap).toMatch(/^cb1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const v = verifyCapability(SECRET, cap, NOW);
    expect(v).toEqual({ ok: true, payload });
  });

  it("fails hard after expiry (410 path)", () => {
    const cap = mintCapability(SECRET, payload);
    expect(verifyCapability(SECRET, cap, payload.exp)).toEqual({ ok: false, reason: "expired" });
    expect(verifyCapability(SECRET, cap, payload.exp + 1)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a tampered payload as badsig — retargeting is impossible", () => {
    const cap = mintCapability(SECRET, payload);
    const [pre, , sig] = cap.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...payload, agent: "other-agent-id", exp: NOW + 999_999_999 }),
    ).toString("base64url");
    expect(verifyCapability(SECRET, `${pre}.${forged}.${sig}`, NOW)).toEqual({
      ok: false,
      reason: "badsig",
    });
  });

  it("rejects a capability minted with a different secret", () => {
    const cap = mintCapability("other-secret", payload);
    expect(verifyCapability(SECRET, cap, NOW)).toEqual({ ok: false, reason: "badsig" });
  });

  it("rejects malformed tokens without throwing", () => {
    for (const bad of ["", "cb1", "cb1.x", "cb2.a.b", "nope.a.b", "cb1..", "cb1.!!.??"]) {
      const v = verifyCapability(SECRET, bad, NOW);
      expect(v.ok, bad).toBe(false);
    }
  });

  it("rejects a signed payload with missing fields as malformed", () => {
    // Sign a structurally wrong payload with the REAL secret: signature passes,
    // shape check must still refuse it.
    const raw = Buffer.from(JSON.stringify({ id: "x" })).toString("base64url");
    const sig = createHmac("sha256", SECRET).update(`cb1.${raw}`).digest().toString("base64url");
    expect(verifyCapability(SECRET, `cb1.${raw}.${sig}`, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("frameVisitorMessage", () => {
  it("wraps the message in an untrusted frame carrying the capability id", () => {
    const framed = frameVisitorMessage("ab12", "hello agent");
    expect(framed).toContain("<ay-callback ab12");
    expect(framed).toContain("untrusted visitor message");
    expect(framed).toContain("hello agent");
    expect(framed).toContain("</ay-callback ab12>");
  });

  it("strips control characters so a visitor cannot inject escapes or Enter", () => {
    const framed = frameVisitorMessage("ab12", "a\u001b[31mred\u0000\rb");
    expect(framed).toContain("a[31mredb");
    // eslint-disable-next-line no-control-regex
    expect(framed).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
  });

  it("keeps newlines and tabs (multi-line messages stay readable)", () => {
    const framed = frameVisitorMessage("ab12", "line1\nline2\tend");
    expect(framed).toContain("line1\nline2\tend");
  });
});

describe("buildSnippet", () => {
  const cap = mintCapability(SECRET, { id: "ab12", agent: "deadbeef1234", exp: NOW + 1000 });

  it("targets <base>/cb/<cap> and is fully self-contained", () => {
    const s = buildSnippet({ base: "https://x1.agent-yes.com/", cap });
    expect(s).toContain(`"https://x1.agent-yes.com/cb/${cap}"`);
    expect(s).toMatch(/^<script>/);
    expect(s).toMatch(/<\/script>$/);
    // No external loads: everything inline, only the endpoint is fetched.
    expect(s).not.toContain("src=");
    expect(s).not.toContain("import ");
  });

  it("handles the expired (410) and rate-limited (429) states explicitly", () => {
    const s = buildSnippet({ base: "http://127.0.0.1:4680", cap });
    expect(s).toContain("410");
    expect(s).toContain("expired");
    expect(s).toContain("429");
  });

  it("sanitizes the title against markup injection", () => {
    const s = buildSnippet({ base: "http://h", cap, title: `<img onerror="x">"'&` });
    expect(s).not.toContain("<img");
    expect(s).toContain('var TITLE = "img onerror=x"');
  });
});
