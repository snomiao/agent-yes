import { describe, expect, it } from "vitest";
import {
  AUTO_RETRY_MAX_DELAY_SECS,
  AUTO_RETRY_REASON_FALLBACK,
  AUTO_RETRY_REASONS,
  autoRetryBackoffMs,
  buildAutoRetryMessage,
  classifyAutoRetryReason,
  formatDurationSecs,
  shouldFireRetry,
} from "./autoRetry.ts";
import { loadSharedCliDefaults } from "./configShared.ts";

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

describe("classifyAutoRetryReason", () => {
  it("maps real banners to inert paraphrases", () => {
    expect(classifyAutoRetryReason("● API Error: 529 Overloaded")).toBe(AUTO_RETRY_REASONS[0]);
    expect(classifyAutoRetryReason("API Error: Response stalled mid-stream.")).toBe(
      AUTO_RETRY_REASONS[1],
    );
    expect(classifyAutoRetryReason("API Error: Connection closed mid-response.")).toBe(
      AUTO_RETRY_REASONS[2],
    );
    expect(classifyAutoRetryReason("Claude usage limit reached")).toBe(AUTO_RETRY_REASONS[3]);
    expect(classifyAutoRetryReason("You are being rate-limited")).toBe(AUTO_RETRY_REASONS[4]);
    expect(classifyAutoRetryReason("API Error: 503 Service Unavailable")).toBe(
      AUTO_RETRY_REASON_FALLBACK,
    );
  });
});

describe("formatDurationSecs", () => {
  it("renders s / m / h forms", () => {
    expect(formatDurationSecs(0)).toBe("0s");
    expect(formatDurationSecs(45)).toBe("45s");
    expect(formatDurationSecs(60)).toBe("1m");
    expect(formatDurationSecs(200)).toBe("3m20s");
    expect(formatDurationSecs(3600)).toBe("1h");
    expect(formatDurationSecs(3900)).toBe("1h05m");
    expect(formatDurationSecs(8 * 3600)).toBe("8h");
  });
});

describe("buildAutoRetryMessage", () => {
  it("is one line and carries attempt/reason/backoff context + ignore clause", () => {
    const msg = buildAutoRetryMessage(3, AUTO_RETRY_REASONS[0], 45, 64);
    expect(msg).not.toContain("\n");
    expect(msg.startsWith("retry [")).toBe(true);
    expect(msg).toContain("#3");
    expect(msg).toContain("45s ago");
    expect(msg).toContain("in 1m04s");
    expect(msg).toContain("giving up after 8h");
    expect(msg).toContain("ignore it");
  });

  // Self-trigger guard: the message is typed into the PTY and stays visible in
  // the transcript, so if it ever matched a CLI's own screen-scrape patterns
  // it would re-arm the retry loop (autoRetry), block the streak reset, kill
  // the session (fatal), or fake a state (working/enter/needsInput). Mirrors
  // rs/src/config.rs test_auto_retry_message_is_inert_against_all_cli_patterns.
  it("never matches any CLI's screen-scrape patterns", async () => {
    const clis = await loadSharedCliDefaults();
    expect(Object.keys(clis).length).toBeGreaterThan(0);
    for (const [cliName, conf] of Object.entries(clis)) {
      for (const reason of AUTO_RETRY_REASONS) {
        const cases: [number, number, number][] = [
          [1, 0, 8],
          [5, 500, 128],
          [12, 30_000, 256],
        ];
        for (const [attempt, since, next] of cases) {
          const msg = buildAutoRetryMessage(attempt, reason, since, next);
          const groups: [string, RegExp[] | undefined][] = [
            ["autoRetry", conf.autoRetry],
            ["fatal", conf.fatal],
            ["enter", conf.enter],
            ["working", conf.working],
            ["needsInput", conf.needsInput],
          ];
          for (const [kind, patterns] of groups) {
            for (const rx of patterns ?? []) {
              expect(
                rx.test(msg),
                `retry message must not match ${cliName}.${kind} /${rx}/: ${msg}`,
              ).toBe(false);
            }
          }
        }
      }
    }
  });
});
