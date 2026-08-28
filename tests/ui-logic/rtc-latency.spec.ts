import { describe, expect, test } from "vitest";
import { updateStreamTrace } from "../../lab/ui/rtc.js";

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
