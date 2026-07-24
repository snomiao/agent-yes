import { describe, expect, it } from "vitest";
import { compareHlc, formatHlc, hlcSend, parseHlc } from "./hlc.ts";

describe("hlc", () => {
  it("round-trips format/parse", () => {
    const s = formatHlc(1_700_000_000_000, 3, "node7");
    expect(parseHlc(s)).toEqual({ ms: 1_700_000_000_000, ctr: 3, node: "node7" });
  });

  it("is lexicographically sortable in HLC order", () => {
    const a = formatHlc(1000, 0, "z"); // earlier ms
    const b = formatHlc(1000, 1, "a"); // same ms, higher ctr
    const c = formatHlc(2000, 0, "a"); // later ms
    expect([c, a, b].sort()).toEqual([a, b, c]);
    expect(compareHlc(a, b)).toBeLessThan(0);
    expect(compareHlc(c, a)).toBeGreaterThan(0);
    expect(compareHlc(a, a)).toBe(0);
  });

  it("advances the ms and resets the counter when wall clock moves forward", () => {
    const prev = formatHlc(1000, 5, "n1");
    expect(parseHlc(hlcSend(prev, 2000, "n1"))).toMatchObject({ ms: 2000, ctr: 0 });
  });

  it("keeps ms and bumps the counter when wall clock has not advanced", () => {
    const prev = formatHlc(5000, 2, "n1");
    // physNow behind the max we've seen (clock skew / same ms) → monotonic via ctr
    expect(parseHlc(hlcSend(prev, 4000, "n1"))).toMatchObject({ ms: 5000, ctr: 3 });
    expect(parseHlc(hlcSend(prev, 5000, "n1"))).toMatchObject({ ms: 5000, ctr: 3 });
  });

  it("is strictly monotonic across repeated sends seeded from the running max", () => {
    let max: string | null = null;
    const out: string[] = [];
    for (let i = 0; i < 100; i++) {
      // simulate a clock that sometimes stalls
      const now = 1000 + (i % 3 === 0 ? 0 : i);
      max = hlcSend(max, now, "n");
      out.push(max);
    }
    for (let i = 1; i < out.length; i++) expect(compareHlc(out[i - 1]!, out[i]!)).toBeLessThan(0);
  });

  it("starts from zero with no prior max", () => {
    expect(parseHlc(hlcSend(null, 42, "n"))).toEqual({ ms: 42, ctr: 0, node: "n" });
  });

  it("rejects malformed and out-of-range values", () => {
    expect(() => parseHlc("nope")).toThrow();
    expect(() => parseHlc("1.2")).toThrow(); // too few fields
    expect(() => formatHlc(-1, 0, "n")).toThrow();
    expect(() => formatHlc(0, -1, "n")).toThrow();
    expect(() => formatHlc(10 ** 15, 0, "n")).toThrow(); // ms overflow
    expect(() => formatHlc(0, 10 ** 6, "n")).toThrow(); // ctr overflow
  });
});
