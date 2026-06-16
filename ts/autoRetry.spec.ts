import { describe, expect, it } from "bun:test";
import { AUTO_RETRY_MAX_DELAY_SECS, autoRetryBackoffMs } from "./autoRetry.ts";

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
