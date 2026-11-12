import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import path from "node:path";
import { fillRoomAlias, hostedRoomMember, roomAliases } from "./roomReplyAlias.ts";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "reply-routing-"));
  vi.stubEnv("AGENT_YES_HOME", home);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe("parent reply route lifecycle", () => {
  it("fills a single-line envelope without adding a body or newline", () => {
    expect(
      fillRoomAlias("<ay-msg ab reply: ay send <alias-for-room-r1>:member:agent>", () => "fleet"),
    ).toBe("<ay-msg ab reply: ay send fleet:member:agent>");
    const unknown = "<ay-msg ab reply: ay send <alias-for-room-r2>:member:agent>";
    expect(fillRoomAlias(unknown, () => undefined)).toBe(unknown);
  });

  it("maps share rooms, keeps the first alias, and ignores HTTP remotes", async () => {
    await writeFile(
      path.join(home, "remotes.yaml"),
      JSON.stringify({
        remotes: {
          fleet: { url: "webrtc://r1:synthetic@signal.example", token: "" },
          duplicate: { url: "webrtc://r1:synthetic@signal.example", token: "" },
          second: { url: "webrtc://r2:synthetic@signal.example", token: "" },
          http: { url: "https://remote.example", token: "synthetic" },
        },
      }),
    );
    expect([...(await roomAliases())]).toEqual([
      ["r1", "fleet"],
      ["r2", "second"],
    ]);
  });

  it("tolerates a missing or corrupt aliases file", async () => {
    expect(await roomAliases()).toEqual(new Map());
    await writeFile(path.join(home, "remotes.yaml"), "remotes: [");
    expect(await roomAliases()).toEqual(new Map());
  });

  it("does not advertise a reply member without a live host lock", async () => {
    expect(await hostedRoomMember(undefined)).toBeUndefined();
    expect(await hostedRoomMember("missing")).toBeUndefined();
    await writeFile(path.join(home, ".share-host-invalid.pid"), "not a pid");
    expect(await hostedRoomMember("invalid")).toBeUndefined();
    await writeFile(path.join(home, ".share-host-dead.pid"), "2222");
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    expect(await hostedRoomMember("dead")).toBeUndefined();
  });

  it("uses the configured member name and treats EPERM as evidence of liveness", async () => {
    await writeFile(path.join(home, ".share-host-r1.pid"), "1111");
    const probe = vi.spyOn(process, "kill").mockReturnValue(true);
    vi.stubEnv("AY_NAME", " worker-a ");
    expect(await hostedRoomMember("r1")).toEqual({ id: "r1", member: "worker-a" });
    expect(probe).toHaveBeenCalledWith(1111, 0);
    probe.mockImplementation(() => {
      throw Object.assign(new Error("other user"), { code: "EPERM" });
    });
    vi.stubEnv("AY_NAME", " ");
    expect(await hostedRoomMember("r1")).toEqual({ id: "r1", member: hostname() });
  });
});
