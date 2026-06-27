import { describe, expect, it } from "vitest";
import { DEFAULT_SIGHOST, isWebrtcSpec, parseWebrtcLink } from "./webrtcLink.ts";

// A representative v2 share secret (e1.<64 hex>); parseSecret keeps the hex `s`.
const SECRET = "e1.982610a3034f065bfe9700037b306a6afeb7dc48567064058e6c4bbc09e502c2";

describe("isWebrtcSpec", () => {
  it("accepts webrtc:// links", () => {
    expect(isWebrtcSpec(`webrtc://r1:${SECRET}@s.agent-yes.com`)).toBe(true);
  });
  it("accepts https share links (have a # fragment)", () => {
    expect(isWebrtcSpec(`https://agent-yes.com/w/#r1:${SECRET}`)).toBe(true);
    expect(isWebrtcSpec(`http://localhost:8080/w/#r1:${SECRET}`)).toBe(true);
  });
  it("rejects http remotes and bare aliases", () => {
    expect(isWebrtcSpec("token@192.168.1.5:7432")).toBe(false);
    expect(isWebrtcSpec("work-mac")).toBe(false);
    expect(isWebrtcSpec("work-mac:claude")).toBe(false);
    expect(isWebrtcSpec("http://192.168.1.5:7432")).toBe(false); // no fragment
  });
});

describe("parseWebrtcLink", () => {
  it("parses webrtc://room:token@host", () => {
    const r = parseWebrtcLink(`webrtc://r223104:${SECRET}@example.com`);
    expect(r).toEqual({ room: "r223104", s: expect.any(String), host: "example.com" });
    expect(r!.s.length).toBeGreaterThan(0);
  });

  it("parses an https share link and defaults the signaling host", () => {
    const r = parseWebrtcLink(`https://agent-yes.com/w/#r223104:${SECRET}`);
    expect(r).toMatchObject({ room: "r223104", host: DEFAULT_SIGHOST });
  });

  it("honors an explicit @sighost in the fragment", () => {
    const r = parseWebrtcLink(`https://agent-yes.com/w/#r1:${SECRET}@sig.example.com`);
    expect(r).toMatchObject({ room: "r1", host: "sig.example.com" });
  });

  it("returns null for non-share strings and malformed fragments", () => {
    expect(parseWebrtcLink("token@host:7432")).toBeNull();
    expect(parseWebrtcLink("just-an-alias")).toBeNull();
    expect(parseWebrtcLink("https://agent-yes.com/w/#noColonHere")).toBeNull();
  });
});
