import { describe, expect, it } from "vitest";
import { parseRoomHash } from "../../lab/ui/rtc.js";

// The console opens three kinds of room reference. The shared-room form that
// `ay share room` prints (#room=<id>&s=<secret>[&sig=<host>]) must parse to the
// same {room, token, host} shape as the others AND be marked `shared`, since
// the console opens it through a roster watcher with one source per host.
const S = "e1." + "a".repeat(64);

describe("parseRoomHash", () => {
  it("parses the shared-room key=value form and marks it shared", () => {
    expect(parseRoomHash(`#room=r0123456789ab&s=${S}`)).toEqual({
      room: "r0123456789ab",
      token: S,
      host: "s.agent-yes.com",
      shared: true,
    });
    expect(parseRoomHash(`room=r0123456789ab&s=${S}&sig=localhost%3A7778`)).toMatchObject({
      host: "localhost:7778",
      shared: true,
    });
    expect(parseRoomHash(`#?room=r0123456789ab&s=${S}`)).toMatchObject({ shared: true });
  });

  it("rejects a shared-room form missing its parts or with a bad id", () => {
    expect(parseRoomHash("#room=r0123456789ab")).toBeNull();
    expect(parseRoomHash(`#room=../x&s=${S}`)).toBeNull();
    expect(parseRoomHash(`#s=${S}`)).toBeNull();
  });

  it("keeps the positional and webrtc:// forms unshared", () => {
    expect(parseRoomHash(`#r0123456789ab:${S}`)).toEqual({
      room: "r0123456789ab",
      token: S,
      host: "s.agent-yes.com",
    });
    expect(parseRoomHash(`webrtc://r0123456789ab:${S}@s.example`)).toEqual({
      room: "r0123456789ab",
      token: S,
      host: "s.example",
    });
    expect(parseRoomHash("#k=abc")).toBeNull();
    expect(parseRoomHash("")).toBeNull();
  });
});
