import { describe, expect, it } from "vitest";
import { shellQuote, toCron } from "./schedule.ts";

describe("toCron", () => {
  it("expands HH:MM to a daily cron", () => {
    expect(toCron("10:00")).toBe("0 10 * * *");
    expect(toCron("9:05")).toBe("5 9 * * *");
    expect(toCron("23:59")).toBe("59 23 * * *");
  });
  it("passes through a 5-field cron expression", () => {
    expect(toCron("0 10 * * *")).toBe("0 10 * * *");
    expect(toCron("*/15 * * * 1-5")).toBe("*/15 * * * 1-5");
  });
  it("rejects out-of-range times and malformed specs", () => {
    expect(toCron("25:00")).toBeNull();
    expect(toCron("10:75")).toBeNull();
    expect(toCron("daily")).toBeNull();
    expect(toCron("0 10 * *")).toBeNull(); // only 4 fields
    expect(toCron("")).toBeNull();
  });
});

describe("shellQuote", () => {
  it("wraps in single quotes for oxmgr's shell parsing", () => {
    expect(shellQuote("a b c")).toBe("'a b c'");
  });
  it("escapes embedded single quotes", () => {
    expect(shellQuote("it's a test")).toBe(`'it'\\''s a test'`);
  });
});
