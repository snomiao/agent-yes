import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Lifecycle of scoped shares: mint / list / revoke / expire. The security filter
// (scopedFetch) is driven with the REAL resolveOne in agentShare.spec.ts; here we
// mock the registry and the WebRTC room so createScopedShare's bookkeeping can be
// exercised hermetically (no signaling server, no live agents).

const closeSpies: Array<ReturnType<typeof vi.fn>> = [];
let roomSeq = 0;

vi.mock("./share.ts", () => ({
  startShare: vi.fn(async () => {
    const close = vi.fn();
    closeSpies.push(close);
    const room = `room-${roomSeq++}`;
    return { room, link: `https://agent-yes.com/w/#${room}:secret`, close };
  }),
}));

const records = new Map<string, Record<string, unknown>>();
vi.mock("./subcommands.ts", () => ({
  listRecords: vi.fn(async () => [...records.values()]),
  resolveOne: vi.fn(async (kw: string) => {
    const rec = records.get(kw);
    if (!rec) throw new Error(`no agent matches ${kw}`);
    return rec;
  }),
}));

import {
  createScopedShare,
  listShares,
  revokeShare,
  revokeAllShares,
  MAX_SHARES,
  DEFAULT_SHARE_TTL_MS,
} from "./agentShare.ts";

const localFetch = async () => new Response("ok");
const baseOpts = { localFetch, apiToken: "tok" };

beforeEach(() => {
  records.clear();
  closeSpies.length = 0;
  records.set("1", { pid: 1, agent_id: "aaaaaaaaaaaa", cli: "claude", cwd: "/home/u/proj" });
});

afterEach(() => {
  revokeAllShares();
  vi.useRealTimers();
});

describe("createScopedShare", () => {
  it("mints a view-only share with a fresh room and a cli · dir label", async () => {
    const share = await createScopedShare({ ...baseOpts, agent: "1" });
    expect(share.agentId).toBe("aaaaaaaaaaaa");
    expect(share.perm).toBe("r"); // default
    expect(share.room).toMatch(/^room-/);
    expect(share.link).toContain(share.room);
    expect(share.label).toBe("claude · proj");
    expect(share.shareId).toMatch(/^s[0-9a-z]+$/);
    expect(share.expiresAt - share.createdAt).toBe(DEFAULT_SHARE_TTL_MS);
    expect("close" in share).toBe(false); // the close capability never leaves the host
  });

  it("labels a cwd-less agent with just the cli and honours perm/ttl overrides", async () => {
    records.set("2", { pid: 2, agent_id: "cccccccccccc", cli: "codex", cwd: "" });
    const share = await createScopedShare({ ...baseOpts, agent: "2", perm: "rw", ttlMs: 5000 });
    expect(share.label).toBe("codex");
    expect(share.perm).toBe("rw");
    expect(share.expiresAt - share.createdAt).toBe(5000);
  });

  it("refuses an agent with no stable agent_id (pid alone is reused → unsafe)", async () => {
    records.set("3", { pid: 3, agent_id: undefined, cli: "claude", cwd: "/x" });
    await expect(createScopedShare({ ...baseOpts, agent: "3" })).rejects.toThrow(/agent_id/);
  });

  it("propagates an unresolvable keyword", async () => {
    await expect(createScopedShare({ ...baseOpts, agent: "nope" })).rejects.toThrow(/no agent/);
  });

  it("caps concurrent shares at MAX_SHARES", async () => {
    for (let i = 0; i < MAX_SHARES; i++) {
      await createScopedShare({ ...baseOpts, agent: "1" });
    }
    await expect(createScopedShare({ ...baseOpts, agent: "1" })).rejects.toThrow(
      /too many active shares/,
    );
  });
});

describe("listShares / revokeShare / revokeAllShares", () => {
  it("lists newest-first without exposing close", async () => {
    vi.useFakeTimers(); // control createdAt so the sort order is deterministic
    const a = await createScopedShare({ ...baseOpts, agent: "1" });
    vi.advanceTimersByTime(10);
    const b = await createScopedShare({ ...baseOpts, agent: "1" });
    const listed = listShares();
    expect(listed.map((s) => s.shareId)).toEqual([b.shareId, a.shareId]);
    for (const s of listed) expect("close" in s).toBe(false);
  });

  it("revokeShare closes the room and forgets the share; unknown id is a no-op", async () => {
    const share = await createScopedShare({ ...baseOpts, agent: "1" });
    expect(revokeShare(share.shareId)).toBe(true);
    expect(closeSpies[0]).toHaveBeenCalledTimes(1);
    expect(listShares()).toHaveLength(0);
    expect(revokeShare(share.shareId)).toBe(false); // already gone
    expect(revokeShare("s-unknown")).toBe(false);
  });

  it("revokeShare survives a close() that throws (room already torn down)", async () => {
    const share = await createScopedShare({ ...baseOpts, agent: "1" });
    closeSpies[0]!.mockImplementation(() => {
      throw new Error("already closed");
    });
    expect(revokeShare(share.shareId)).toBe(true);
    expect(listShares()).toHaveLength(0);
  });

  it("revokeAllShares closes every room", async () => {
    await createScopedShare({ ...baseOpts, agent: "1" });
    await createScopedShare({ ...baseOpts, agent: "1" });
    revokeAllShares();
    expect(listShares()).toHaveLength(0);
    expect(closeSpies).toHaveLength(2);
    for (const spy of closeSpies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a share self-revokes when its TTL elapses", async () => {
    vi.useFakeTimers();
    const share = await createScopedShare({ ...baseOpts, agent: "1", ttlMs: 1000 });
    expect(listShares().map((s) => s.shareId)).toContain(share.shareId);
    vi.advanceTimersByTime(1001);
    expect(listShares()).toHaveLength(0);
    expect(closeSpies[0]).toHaveBeenCalledTimes(1);
  });
});
