import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  formatRoomLink,
  loadOrCreateShareRoom,
  readShareRoom,
  shareLinkFromRoomUrl,
  shareRoomFileName,
  shareRoomPath,
} from "./share.ts";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { parseWebrtcLink, toWebrtcUrl } from "./webrtcLink.ts";
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
    // The message must name the shape operators actually hold (the /room/ link),
    // not the internal webrtc:// form they are never shown.
    expect(() => shareLinkFromRoomUrl("not-a-webrtc-url")).toThrow(/\/room\/#room=/);
  });
});

// The /room/ link is BOTH what an operator opens in a browser and what they
// paste into `ay serve --webrtc`. So whatever formatRoomLink prints must survive
// the CLI's own parser — if these two ever drift, the printed link stops working
// in the tool that printed it, which no other test would catch.
describe("formatRoomLink \u2194 the CLI parser", () => {
  it("prints a link toWebrtcUrl normalizes back to the same room", () => {
    const link = formatRoomLink("r1a2b3c", S, "s.agent-yes.com");
    expect(link).toBe(`https://agent-yes.com/room/#room=r1a2b3c&s=${MARKER}${S}`);
    expect(toWebrtcUrl(link)).toBe(`webrtc://r1a2b3c:${MARKER}${S}@s.agent-yes.com`);
    expect(parseWebrtcLink(link)).toEqual({ room: "r1a2b3c", s: S, host: "s.agent-yes.com" });
  });

  it("carries a non-prod signaling host as sig= and round-trips it too", () => {
    const link = formatRoomLink("r1a2b3c", S, "localhost:7778");
    expect(link).toContain("sig=localhost%3A7778");
    expect(parseWebrtcLink(link)).toMatchObject({ room: "r1a2b3c", host: "localhost:7778" });
  });
});

// The two hosts persist their rooms in different files (same format). Minting
// and reading must target the file of the runtime that hosts, and a read must
// never mint — `ay serve status` is read-only.
describe("share room files per runtime", () => {
  let home: string;
  const prev = process.env.AGENT_YES_HOME;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "ay-share-room-"));
    process.env.AGENT_YES_HOME = home;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = prev;
    await rm(home, { recursive: true, force: true });
  });

  it("maps each runtime to its own file", () => {
    expect(shareRoomFileName("ts")).toBe(".share-room");
    expect(shareRoomFileName("rust")).toBe(".share-room-ayrs");
    expect(shareRoomPath("rust")).toBe(path.join(home, ".share-room-ayrs"));
    expect(shareRoomPath()).toBe(path.join(home, ".share-room"));
  });

  it("mints into the rust file and leaves the ts file alone", async () => {
    const url = await loadOrCreateShareRoom("s.example", "rust");
    expect(url).toMatch(/^webrtc:\/\/r[0-9a-f]{12}:e1\.[0-9a-f]{64}@s\.example$/);
    expect((await readFile(path.join(home, ".share-room-ayrs"), "utf-8")).trim()).toBe(url);
    await expect(readFile(path.join(home, ".share-room"))).rejects.toThrow();
    // Stable: a second load returns the persisted room, no re-mint.
    expect(await loadOrCreateShareRoom("s.example", "rust")).toBe(url);
  });

  it("reports the ayrs room only while a live pid holds it", async () => {
    const { foregroundAyrsShareLink } = await import("./shareCmd.ts");
    expect(await foregroundAyrsShareLink()).toBeNull();
    const url = await loadOrCreateShareRoom("s.example", "rust");
    const room = url.slice("webrtc://".length).split(":")[0];
    const lock = path.join(home, `.share-host-${room}.pid`);
    expect(await foregroundAyrsShareLink()).toBeNull(); // nobody hosts it
    await writeFile(lock, String(process.pid));
    expect(await foregroundAyrsShareLink()).toBe(shareLinkFromRoomUrl(url));
    await writeFile(lock, "2147483646"); // a pid that is not running
    expect(await foregroundAyrsShareLink()).toBeNull();
  });

  it("reads without minting, and ignores a legacy unencrypted room", async () => {
    expect(await readShareRoom("rust")).toBeNull();
    await expect(readFile(path.join(home, ".share-room-ayrs"))).rejects.toThrow();
    await writeFile(path.join(home, ".share-room"), `webrtc://room0:${S}@s.example`);
    expect(await readShareRoom("ts")).toBeNull();
    await writeFile(path.join(home, ".share-room"), `webrtc://room0:${TOK}@s.example`);
    expect(await readShareRoom("ts")).toBe(`webrtc://room0:${TOK}@s.example`);
  });
});
