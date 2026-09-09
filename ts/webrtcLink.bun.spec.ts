import { describe, expect, it } from "bun:test";
import { DEFAULT_SIGHOST, isWebrtcSpec, parseWebrtcLink, toWebrtcUrl } from "./webrtcLink.ts";

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

  it("parses the key=value /room/ fragment", () => {
    const r = parseWebrtcLink(`https://agent-yes.com/room/#room=r223104&s=${SECRET}`);
    expect(r).toMatchObject({ room: "r223104", host: DEFAULT_SIGHOST });
  });

  it("honors sig= and tolerates a leading ? in the key=value form", () => {
    expect(
      parseWebrtcLink(`https://agent-yes.com/room/#?room=r1&s=${SECRET}&sig=sig.example.com`),
    ).toMatchObject({ room: "r1", host: "sig.example.com" });
  });

  it("returns null when the key=value form is missing room or s", () => {
    expect(parseWebrtcLink(`https://agent-yes.com/room/#room=r1`)).toBeNull();
    expect(parseWebrtcLink(`https://agent-yes.com/room/#s=${SECRET}`)).toBeNull();
  });

  // The fragment namespace is shared with #k=, #ch= and #launch= (see
  // parseRoomHash in lab/ui/rtc.js); a foreign key set must not be read as a room.
  it("does not mistake another feature's hash for a room", () => {
    expect(parseWebrtcLink("https://agent-yes.com/w/#k=deadbeef")).toBeNull();
    expect(parseWebrtcLink("https://agent-yes.com/w/#launch=claude")).toBeNull();
  });
});

describe("toWebrtcUrl", () => {
  it("normalizes every accepted spelling to the internal webrtc:// form", () => {
    const want = `webrtc://r1:${SECRET}@${DEFAULT_SIGHOST}`;
    expect(toWebrtcUrl(`https://agent-yes.com/room/#room=r1&s=${SECRET}`)).toBe(want);
    expect(toWebrtcUrl(`https://agent-yes.com/w/#r1:${SECRET}`)).toBe(want);
    expect(toWebrtcUrl(want)).toBe(want);
  });

  // parseSecret strips the "e1." marker; rebuilding from the parsed `s` would
  // hand a legacy markerless room a marker it never had, changing the token the
  // signaling DO pinned the room to.
  it("round-trips a legacy markerless token unchanged", () => {
    const legacy = `webrtc://r1:plaintexttoken@${DEFAULT_SIGHOST}`;
    expect(toWebrtcUrl(legacy)).toBe(legacy);
  });

  it("returns null for a non-link", () => {
    expect(toWebrtcUrl("just-an-alias")).toBeNull();
  });
});
