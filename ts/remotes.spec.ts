import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdRemote, MASK, maskRemoteUrl, writeRemoteAlias } from "./remotes.ts";
import { parseWebrtcLink } from "./webrtcLink.ts";

// Synthetic secrets only — a v2 share secret shape (e1.<64 hex>) and a plain token.
const SECRET = "e1.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TOKEN = "tok-aaaaaaaabbbbbbbbcccccccc";

describe("maskRemoteUrl", () => {
  it("masks the token of a webrtc:// link, keeping room and host", () => {
    expect(maskRemoteUrl(`webrtc://room1:${SECRET}@s.example.com`)).toBe(
      `webrtc://room1:${MASK}@s.example.com`,
    );
  });
  it("masks a positional /w/ share link, with and without a sighost", () => {
    expect(maskRemoteUrl(`https://agent-yes.com/w/#room1:${SECRET}`)).toBe(
      `https://agent-yes.com/w/#room1:${MASK}`,
    );
    expect(maskRemoteUrl(`https://agent-yes.com/w/#room1:${SECRET}@s.example.com`)).toBe(
      `https://agent-yes.com/w/#room1:${MASK}@s.example.com`,
    );
  });
  it("masks s= and k= in a key=value fragment, keeping the other keys", () => {
    expect(maskRemoteUrl(`https://agent-yes.com/room/#room=room1&s=${SECRET}&sig=s.x`)).toBe(
      `https://agent-yes.com/room/#room=room1&s=${MASK}&sig=s.x`,
    );
    expect(maskRemoteUrl(`https://box.example.ts.net/ay/#k=${TOKEN}`)).toBe(
      `https://box.example.ts.net/ay/#k=${MASK}`,
    );
  });
  it("masks percent-encoded secret keys, which URLSearchParams decodes on use", () => {
    expect(maskRemoteUrl(`https://agent-yes.com/room/#room=room1&%73=${SECRET}`)).toBe(
      `https://agent-yes.com/room/#room=room1&%73=${MASK}`,
    );
    expect(maskRemoteUrl(`https://agent-yes.com/room/#%73=${SECRET}&room=room1`)).toBe(
      `https://agent-yes.com/room/#%73=${MASK}&room=room1`,
    );
    expect(maskRemoteUrl(`https://box.example.ts.net/ay/#?%6B=${TOKEN}`)).toBe(
      `https://box.example.ts.net/ay/#?%6B=${MASK}`,
    );
  });
  it("treats a room id containing `=` as positional, like the parser does", () => {
    expect(maskRemoteUrl(`https://agent-yes.com/w/#room1=demo:${SECRET}`)).toBe(
      `https://agent-yes.com/w/#room1=demo:${MASK}`,
    );
  });
  it("masks a malformed webrtc:// link that has no @host", () => {
    expect(maskRemoteUrl(`webrtc://room1:${SECRET}`)).toBe(`webrtc://room1:${MASK}`);
  });
  it("masks userinfo credentials", () => {
    expect(maskRemoteUrl(`http://${TOKEN}@192.0.2.5:7432`)).toBe(`http://${MASK}@192.0.2.5:7432`);
  });
  it("leaves a URL without secrets untouched", () => {
    expect(maskRemoteUrl("http://192.0.2.5:7432")).toBe("http://192.0.2.5:7432");
    expect(maskRemoteUrl("https://box.example.ts.net/ay")).toBe("https://box.example.ts.net/ay");
  });
});

// Cross-check against the real parser: whatever it accepts as a working share
// link, the masked form must not contain the secret it would connect with.
describe("maskRemoteUrl vs parseWebrtcLink", () => {
  const HEX = SECRET.slice(3);
  const links = [
    `webrtc://room1:${SECRET}@s.example.com`,
    `https://agent-yes.com/w/#room1:${SECRET}`,
    `https://agent-yes.com/w/#room1:${SECRET}@s.example.com`,
    `https://agent-yes.com/w/#room1=demo:${SECRET}`,
    `https://agent-yes.com/room/#room=room1&s=${SECRET}`,
    `https://agent-yes.com/room/#?room=room1&s=${SECRET}&sig=s.example.com`,
    `https://agent-yes.com/room/#room=room1&%73=${SECRET}`,
    `https://agent-yes.com/room/#s=${SECRET}&room=room1`,
  ];
  for (const link of links) {
    it(`hides the secret of ${link.replace(SECRET, "<secret>")}`, () => {
      expect(parseWebrtcLink(link)?.s).toBe(HEX); // the parser accepts it
      expect(maskRemoteUrl(link)).not.toContain(HEX.slice(0, 16));
    });
  }
});

describe("ay remote ls", () => {
  let home: string;
  let out: string;
  let prevHome: string | undefined;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "ay-remotes-"));
    prevHome = process.env.AGENT_YES_HOME;
    process.env.AGENT_YES_HOME = home;
    out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((c: any) => ((out += String(c)), true));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await writeRemoteAlias("rtc", { url: `https://agent-yes.com/w/#room1:${SECRET}`, token: "" });
    await writeRemoteAlias("lan", { url: "http://192.0.2.5:7432", token: TOKEN });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (prevHome === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  });

  it("masks every secret by default", async () => {
    expect(await cmdRemote(["ls"])).toBe(0);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(TOKEN.slice(0, 8));
    expect(out).toContain(`rtc\thttps://agent-yes.com/w/#room1:${MASK}\n`);
    expect(out).toContain(`lan\thttp://192.0.2.5:7432\ttoken:${MASK}\n`);
  });
  it("reveals secrets with --show-secrets", async () => {
    expect(await cmdRemote(["ls", "--show-secrets"])).toBe(0);
    expect(out).toContain(SECRET);
    expect(out).toContain(`token:${TOKEN}`);
  });
  it("accepts the flag without the ls verb", async () => {
    expect(await cmdRemote(["--show-secrets"])).toBe(0);
    expect(out).toContain(SECRET);
  });
  it("rejects an unknown flag instead of ignoring it", async () => {
    expect(await cmdRemote(["ls", "--show-secret"])).toBe(1);
    expect(out).toBe("");
  });
});
