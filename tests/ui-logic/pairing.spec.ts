import { describe, expect, it } from "vitest";
import {
  MARKER,
  assertShellSafe,
  consoleUrlFor,
  mintPairing,
  pairingCommands,
} from "../../lab/ui/pairing.js";

const ORIGIN = "https://agent-yes.com";

/** Deterministic filler: byte i = i, so the hex is predictable per length. */
const seq = (buf: Uint8Array) => {
  for (let i = 0; i < buf.length; i++) buf[i] = i;
};

describe("mintPairing", () => {
  it("mints the same room/secret shapes the host side uses", () => {
    const p = mintPairing({ origin: ORIGIN, rand: seq });
    // ts/share.ts: room = "r" + randomBytes(6).hex, S = randomBytes(32).hex
    expect(p.room).toMatch(/^r[0-9a-f]{12}$/);
    expect(p.token).toMatch(/^e1\.[0-9a-f]{64}$/);
    expect(p.token.startsWith(MARKER)).toBe(true);
  });

  it("puts the secret in the fragment, never the path or query", () => {
    const p = mintPairing({ origin: ORIGIN, rand: seq });
    const secret = p.token.slice(MARKER.length);
    const [beforeHash, afterHash] = [
      p.link.slice(0, p.link.indexOf("#")),
      p.link.slice(p.link.indexOf("#")),
    ];
    expect(beforeHash).toBe(`${ORIGIN}/room/`);
    expect(beforeHash).not.toContain(secret);
    expect(afterHash).toContain(secret);
    expect(p.link).toBe(`${ORIGIN}/room/#room=${p.room}&s=${p.token}`);
  });

  it("mints a fresh room every call", () => {
    const a = mintPairing({ origin: ORIGIN });
    const b = mintPairing({ origin: ORIGIN });
    expect(a.room).not.toBe(b.room);
    expect(a.token).not.toBe(b.token);
  });

  it("appends a non-default signaling host and omits the default", () => {
    const custom = mintPairing({ origin: ORIGIN, sigHost: "sig.example.com", rand: seq });
    expect(custom.link).toContain("&sig=sig.example.com");
    const dflt = mintPairing({ origin: ORIGIN, sigHost: "s.agent-yes.com", rand: seq });
    expect(dflt.link).not.toContain("&sig=");
  });

  it("tolerates a trailing slash on the origin", () => {
    const p = mintPairing({ origin: "https://agent-yes.com/", rand: seq });
    expect(p.link.startsWith(`${ORIGIN}/room/#`)).toBe(true);
    expect(p.sh).toContain(`${ORIGIN}/setup.sh`);
  });
});

describe("pairingCommands", () => {
  const link = `${ORIGIN}/room/#room=rdeadbeef0000&s=${MARKER}${"a".repeat(64)}`;

  it("passes the secret in the environment, not as an argument", () => {
    const { sh } = pairingCommands({ origin: ORIGIN, link });
    // The link must precede the command word — an `ay serve --webrtc <link>`
    // style argv would expose it via /proc/<pid>/cmdline.
    expect(sh).toBe(`AY_JOIN='${link}' sh -c "$(curl -fsSL ${ORIGIN}/setup.sh)"`);
    expect(sh.indexOf("AY_JOIN=")).toBeLessThan(sh.indexOf("sh -c"));
  });

  it("single-quotes the link so & and # never reach the shell", () => {
    const { sh, ps } = pairingCommands({ origin: ORIGIN, link });
    for (const cmd of [sh, ps]) expect(cmd).toContain(`'${link}'`);
  });

  it("emits PowerShell-native syntax, not a powershell -c wrapper", () => {
    const { ps } = pairingCommands({ origin: ORIGIN, link });
    // A `powershell -c "$env:AY_JOIN=…"` wrapper is expanded by the OUTER
    // shell when pasted into PowerShell, so the inner shell gets `='…'`.
    expect(ps).toBe(`$env:AY_JOIN='${link}'; irm ${ORIGIN}/setup.ps1 | iex`);
    expect(ps).not.toContain("powershell -c");
  });
});

describe("consoleUrlFor", () => {
  it("uses the positional #room:token form /w/ reads, secret in the fragment", () => {
    const token = `${MARKER}${"b".repeat(64)}`;
    const url = consoleUrlFor({ origin: ORIGIN, room: "rdeadbeef0000", token });
    expect(url).toBe(`${ORIGIN}/w/#rdeadbeef0000:${token}`);
    // Everything before the '#' is what a server would see — the secret must
    // not be in it.
    expect(url.split("#")[0]).not.toContain(token);
    expect(url.split("#")[1]).toContain(token);
  });

  it("appends @sighost only for a non-default signaling host", () => {
    const token = `${MARKER}${"c".repeat(64)}`;
    expect(consoleUrlFor({ origin: ORIGIN, room: "r1", token, sigHost: "sig.example.com" })).toBe(
      `${ORIGIN}/w/#r1:${token}@sig.example.com`,
    );
    expect(consoleUrlFor({ origin: ORIGIN, room: "r1", token, sigHost: "s.agent-yes.com" })).toBe(
      `${ORIGIN}/w/#r1:${token}`,
    );
  });

  it("is the link mintPairing hands the landing page, for the same room", () => {
    const p = mintPairing({ origin: ORIGIN, rand: seq });
    expect(p.consoleUrl).toBe(consoleUrlFor({ origin: ORIGIN, room: p.room, token: p.token }));
    expect(p.consoleUrl).toContain(p.room);
  });
});

describe("assertShellSafe", () => {
  it("accepts a real minted link (hyphenated host included)", () => {
    const p = mintPairing({ origin: ORIGIN, rand: seq });
    expect(assertShellSafe(p.link)).toBe(p.link);
    expect(() => mintPairing({ origin: "https://my-beta-host.example", rand: seq })).not.toThrow();
  });

  it.each([
    ["single quote", `${ORIGIN}/room/#room=r1'&s=x`],
    ["double quote", `${ORIGIN}/room/#room=r1"&s=x`],
    ["backslash", `${ORIGIN}/room/#room=r1\\&s=x`],
    ["space", `${ORIGIN}/room/#room=r1 &s=x`],
    ["newline", `${ORIGIN}/room/#room=r1\n&s=x`],
    ["control byte", `${ORIGIN}/room/#room=r1\u0007&s=x`],
  ])("refuses a link containing a %s", (_label, bad) => {
    expect(() => assertShellSafe(bad)).toThrow(/unsafe room link/);
    expect(() => pairingCommands({ origin: ORIGIN, link: bad })).toThrow(/unsafe room link/);
  });
});
