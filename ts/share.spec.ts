import { describe, it, expect } from "vitest";
import { shareLinkFromRoomUrl } from "./share.ts";
import { MARKER } from "../lab/ui/e2e.js";

const S = "a".repeat(64); // a valid 64-hex room secret
const TOK = `${MARKER}${S}`; // encrypted-room token (v2)

// shareLinkFromRoomUrl turns a persisted/explicit webrtc://room:token@host room
// into the browser console link `ay serve install` prints — it MUST match the
// link startShare announces from the same room (both go through formatShareLink).
describe("shareLinkFromRoomUrl", () => {
  it("derives the prod console link (no host suffix; secret rides in the fragment)", () => {
    const link = shareLinkFromRoomUrl(`webrtc://r1a2b3c:${TOK}@s.agent-yes.com`);
    expect(link).toBe(`https://agent-yes.com/w/#r1a2b3c:${MARKER}${S}`);
  });

  it("derives a dev/self-hosted link carrying the signaling host in the fragment", () => {
    const link = shareLinkFromRoomUrl(`webrtc://r1a2b3c:${TOK}@localhost:7778`);
    expect(link).toBe(`http://localhost:7778/w/#r1a2b3c:${MARKER}${S}@localhost:7778`);
  });

  it("round-trips room + token in the fragment the browser splits back out", () => {
    const link = shareLinkFromRoomUrl(`webrtc://room0:${TOK}@s.agent-yes.com`);
    expect(link.split("#")[1]).toBe(`room0:${TOK}`);
  });

  it("refuses a legacy (unencrypted) room — operator must rotate to an encrypted link", () => {
    expect(() => shareLinkFromRoomUrl(`webrtc://room0:${S}@s.agent-yes.com`)).toThrow(
      /unencrypted/,
    );
  });

  it("rejects a malformed room url", () => {
    expect(() => shareLinkFromRoomUrl("not-a-webrtc-url")).toThrow(/webrtc:\/\//);
  });
});
