import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";
const io = vi.hoisted(() => ({ read: vi.fn(), remotes: vi.fn() }));
vi.mock("fs/promises", () => ({ readFile: io.read }));
vi.mock("./remotes.ts", () => ({ readRemotes: io.remotes }));
vi.mock("os", () => ({ hostname: () => "example-host", homedir: () => "/home/example" }));
import { fillRoomAlias, hostedRoomMember, roomAliases } from "./roomReplyAlias.ts";

describe("room reply routes and host identity", () => {
  beforeEach(() => {
    vi.stubEnv("AGENT_YES_HOME", "/state/example");
    vi.stubEnv("AY_NAME", "  example-member  ");
    io.read.mockReset().mockResolvedValue("1111\n");
    io.remotes.mockReset().mockResolvedValue(new Map());
    vi.spyOn(process, "kill").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("fills a header without a newline and preserves unknown placeholders", () => {
    expect(fillRoomAlias("<ay-msg ab <alias-for-room-r1>>", () => "fleet")).toBe(
      "<ay-msg ab fleet>",
    );
    expect(fillRoomAlias("<ay-msg ab <alias-for-room-r1>>", () => undefined)).toBe(
      "<ay-msg ab <alias-for-room-r1>>",
    );
  });
  it("chooses the first alias for each valid share room and ignores non-share remotes", async () => {
    const link = `webrtc://room-a:e1.${"a".repeat(64)}@signal.example`;
    io.remotes.mockResolvedValue(
      new Map([
        ["first", { url: link }],
        ["duplicate", { url: link }],
        ["http", { url: "https://example.invalid" }],
        ["missing", {}],
        ["null", null],
      ]),
    );
    expect(await roomAliases()).toEqual(new Map([["room-a", "first"]]));
  });
  it("returns an empty alias map when remote configuration cannot be read", async () => {
    io.remotes.mockRejectedValue(new Error("unreadable configuration"));
    expect(await roomAliases()).toEqual(new Map());
  });
  it("does not read a host lock without a room", async () => {
    expect(await hostedRoomMember(undefined)).toBeUndefined();
    expect(io.read).not.toHaveBeenCalled();
  });
  it("uses the configured member name for a live host lock", async () => {
    expect(await hostedRoomMember("room-a")).toEqual({ id: "room-a", member: "example-member" });
    expect(io.read).toHaveBeenCalledWith(
      path.join("/state/example", ".share-host-room-a.pid"),
      "utf-8",
    );
    expect(process.kill).toHaveBeenCalledWith(1111, 0);
  });
  it("falls back to the hostname for an empty member name or an inaccessible live pid", async () => {
    vi.stubEnv("AY_NAME", " ");
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    expect(await hostedRoomMember("room-a")).toEqual({ id: "room-a", member: "example-host" });
    vi.stubEnv("AY_NAME", undefined);
    expect(await hostedRoomMember("room-a")).toEqual({ id: "room-a", member: "example-host" });
  });
  it("ignores invalid, missing and stale host locks", async () => {
    for (const value of ["0", "-1", "not a pid"]) {
      io.read.mockResolvedValue(value);
      expect(await hostedRoomMember("room-a")).toBeUndefined();
    }
    io.read.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    expect(await hostedRoomMember("room-a")).toBeUndefined();
    io.read.mockResolvedValue("1111");
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    expect(await hostedRoomMember("room-a")).toBeUndefined();
  });
});
