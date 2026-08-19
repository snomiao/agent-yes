import { describe, expect, it } from "vitest";
import { sweep, windowLen } from "./serveSampler.ts";

describe("serveSampler", () => {
  it("windowLen tracks the adaptive bucket width", () => {
    expect(windowLen(60)).toBe(60); // fast: 1m buckets, 1h window
    expect(windowLen(300)).toBe(12); // slow: 5m buckets, 1h window
    expect(windowLen(1)).toBe(60); // anything ≤60 counts as fast
  });

  it("sweep with no live roots still settles a bucket width", async () => {
    const width = await sweep([]);
    expect(width).toBeGreaterThan(0);
    expect([60, 300]).toContain(width);
  });
});
