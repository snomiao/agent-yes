import { describe, expect, test } from "vitest";
import { RTCClient, updateStreamTrace } from "../../lab/ui/rtc.js";

describe("RTC stream latency telemetry", () => {
  test("tracks sequence gaps and maximum inter-chunk delay", () => {
    const stream = { nextSeq: 0, lastAt: 0, maxGapMs: 0 };

    expect(updateStreamTrace(stream, 0, 10)).toBeNull();
    expect(updateStreamTrace(stream, 1, 14)).toBeNull();
    expect(updateStreamTrace(stream, 3, 25)).toEqual({ expected: 2, actual: 3 });
    expect(stream).toEqual({ nextSeq: 4, lastAt: 25, maxGapMs: 11 });
  });

  test("never reports a negative interval after a clock reset", () => {
    const stream = { nextSeq: 4, lastAt: 25, maxGapMs: 11 };
    updateStreamTrace(stream, 4, 20);
    expect(stream.maxGapMs).toBe(11);
  });
});

describe("RTC low-latency stdin", () => {
  test("assigns monotonic sequence numbers and only waits for wire admission", async () => {
    const rtc = new RTCClient("signal.test", "room", "token");
    const sent: unknown[] = [];
    rtc._dcSend = async (_flags: number, envelope: unknown) => {
      sent.push(envelope);
    };

    await Promise.all([rtc.sendInput(42, "a"), rtc.sendInput("42", "b")]);

    expect(sent).toEqual([
      { t: "stdin", pid: "42", seq: 1, msg: "a" },
      { t: "stdin", pid: "42", seq: 2, msg: "b" },
    ]);
  });

  test("tracks cumulative acknowledgements without moving backwards", () => {
    const rtc = new RTCClient("signal.test", "room", "token");
    rtc._recv({ t: "stdin_ack", seq: 3, status: 204 });
    rtc._recv({ t: "stdin_ack", seq: 2, status: 204 });
    expect(rtc._inputAck).toBe(3);
  });

  test("rejects non-text input instead of silently changing its bytes", async () => {
    const rtc = new RTCClient("signal.test", "room", "token");
    await expect(rtc.sendInput(42, new Uint8Array([1]))).rejects.toThrow(
      "terminal input must be text",
    );
  });
});
