import { describe, expect, it } from "vitest";
import {
  ConnectError,
  closeError,
  describeConnectFailure,
  reduceSignal,
  socketError,
  timeoutError,
  type SignalState,
} from "./webrtcSignal.ts";

const fresh = (): SignalState => ({ opened: false, offered: false, confirmed: false });
const opened = (): SignalState => ({ opened: true, offered: false, confirmed: false });
const offered = (): SignalState => ({ opened: true, offered: true, confirmed: false });

// Every one of these used to be a 25 s "connect timeout" followed by a hint
// that blamed a sandbox. The server says which it is; the viewer must listen.
describe("reduceSignal", () => {
  it("fails fast when the server says no host is attached", () => {
    const a = reduceSignal(opened(), { type: "welcome", hostPresent: false });
    expect(a.kind).toBe("fail");
    if (a.kind === "fail") expect(a.error.phase).toBe("no-host");
    expect(reduceSignal(opened(), { type: "welcome", hostPresent: true })).toEqual({
      kind: "ignore",
    });
    expect(reduceSignal(opened(), { type: "welcome" })).toEqual({ kind: "ignore" });
  });

  it("accepts the first offer and refuses a second one (two hosts in a room)", () => {
    expect(
      reduceSignal(opened(), { type: "offer", sdp: "v=0", iceServers: [{ urls: "stun:x" }] }),
    ).toEqual({
      kind: "offer",
      sdp: "v=0",
      iceServers: [{ urls: "stun:x" }],
      from: undefined,
    });
    expect(reduceSignal(offered(), { type: "offer", sdp: "v=0" })).toEqual({
      kind: "duplicate-offer",
    });
  });

  it("queues a candidate that arrives before the offer, applies one after", () => {
    expect(reduceSignal(opened(), { type: "candidate", candidate: { c: 1 } })).toEqual({
      kind: "candidate",
      candidate: { c: 1 },
      queue: true,
    });
    expect(reduceSignal(offered(), { type: "candidate", candidate: { c: 2 } })).toEqual({
      kind: "candidate",
      candidate: { c: 2 },
      queue: false,
    });
  });

  it("ignores anything else, including garbage", () => {
    expect(reduceSignal(opened(), { type: "peer-join" })).toEqual({ kind: "ignore" });
    expect(reduceSignal(opened(), null)).toEqual({ kind: "ignore" });
    expect(reduceSignal(opened(), "nope")).toEqual({ kind: "ignore" });
  });
});

describe("closeError / timeoutError / socketError", () => {
  it("keeps the server's close code and reason, and names the phase", () => {
    expect(closeError(fresh(), 1006, "")).toMatchObject({ phase: "ws-not-open" });
    expect(closeError(opened(), 1008, "forbidden")).toMatchObject({
      phase: "rejected",
      message: expect.stringContaining("1008: forbidden"),
    });
    expect(closeError(opened(), 1000, "room not open")).toMatchObject({ phase: "rejected" });
    expect(closeError(opened(), 1006, "")).toMatchObject({ phase: "no-host" });
    expect(closeError(offered(), 1006, "")).toMatchObject({ phase: "ice-timeout" });
  });

  it("times out into the phase the join had reached", () => {
    expect(timeoutError(fresh(), 25_000)).toMatchObject({ phase: "ws-not-open" });
    expect(timeoutError(opened(), 25_000)).toMatchObject({
      phase: "no-host",
      message: expect.stringContaining("25s"),
    });
    expect(timeoutError(offered(), 25_000)).toMatchObject({ phase: "ice-timeout" });
  });

  it("treats a socket error before open as the socket not opening", () => {
    expect(socketError(fresh(), "ECONNRESET")).toMatchObject({ phase: "ws-not-open" });
    expect(socketError(opened(), "ECONNRESET")).toMatchObject({ phase: "rejected" });
  });
});

describe("describeConnectFailure", () => {
  const host = "s.example";
  const sandbox = async (cause: string) => `SANDBOX-HINT(${cause})`;

  it("consults the sandbox hint only for a socket that never opened", async () => {
    expect(await describeConnectFailure(new ConnectError("ws-not-open", "x"), host, sandbox)).toBe(
      "SANDBOX-HINT(x)",
    );
    // A plain Error (no phase) is treated the same way — nothing is known.
    expect(await describeConnectFailure(new Error("y"), host, sandbox)).toBe("SANDBOX-HINT(y)");
    for (const phase of ["no-host", "rejected", "ice-timeout"] as const) {
      const text = await describeConnectFailure(new ConnectError(phase, "cause"), host, sandbox);
      expect(text).not.toContain("SANDBOX");
      expect(text).not.toMatch(/sandbox.*permission/i);
      expect(text).toContain("cause");
      expect(text).toContain(host);
    }
  });

  it("tells the operator what to do on the host for each phase", async () => {
    expect(await describeConnectFailure(new ConnectError("no-host", "c"), host, sandbox)).toContain(
      "ay share status",
    );
    expect(
      await describeConnectFailure(new ConnectError("rejected", "c"), host, sandbox),
    ).toContain("re-add the remote");
    expect(
      await describeConnectFailure(new ConnectError("ice-timeout", "c"), host, sandbox),
    ).toContain("not a sandbox");
  });
});
