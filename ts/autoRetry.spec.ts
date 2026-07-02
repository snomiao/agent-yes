import { describe, expect, it } from "vitest";
import { AUTO_RETRY_MAX_DELAY_SECS, autoRetryBackoffMs, shouldFireRetry } from "./autoRetry.ts";

describe("autoRetryBackoffMs", () => {
  it("doubles 8,16,32,…,256 then caps", () => {
    expect(autoRetryBackoffMs(0)).toBe(8_000);
    expect(autoRetryBackoffMs(1)).toBe(16_000);
    expect(autoRetryBackoffMs(2)).toBe(32_000);
    expect(autoRetryBackoffMs(3)).toBe(64_000);
    expect(autoRetryBackoffMs(4)).toBe(128_000);
    expect(autoRetryBackoffMs(5)).toBe(256_000);
  });

  it("caps at the max delay and never overflows for large streaks", () => {
    expect(autoRetryBackoffMs(6)).toBe(AUTO_RETRY_MAX_DELAY_SECS * 1000);
    expect(autoRetryBackoffMs(50)).toBe(AUTO_RETRY_MAX_DELAY_SECS * 1000);
    expect(Number.isFinite(autoRetryBackoffMs(1000))).toBe(true);
  });
});

describe("shouldFireRetry", () => {
  it("requires ready + not working + past the idle window", () => {
    // Busy — never fire even if otherwise ready and quiet.
    expect(shouldFireRetry(true, true, 10_000, 5_000)).toBe(false);
    // Not at a recognized ready prompt — don't fire.
    expect(shouldFireRetry(false, false, 10_000, 5_000)).toBe(false);
    // Ready and idle, but the quiet window hasn't elapsed yet (user may still
    // be mid-typing) — defer.
    expect(shouldFireRetry(false, true, 4_999, 5_000)).toBe(false);
    // Ready, idle, and past the quiet window — fire.
    expect(shouldFireRetry(false, true, 5_000, 5_000)).toBe(true);
    expect(shouldFireRetry(false, true, 10_000, 5_000)).toBe(true);
  });
});
