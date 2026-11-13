import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdleWaiter } from "../idleWaiter.ts";
import { ReadyManager } from "../ReadyManager.ts";
import { sendEnter, type MessageContext } from "./messaging.ts";

const PROMPT = " Do you want to proceed?\n ❯ 1. Yes\n   2. No";

function harness() {
  let screen = PROMPT;
  const writes: string[] = [];
  const ctx: MessageContext = {
    shell: { write: (d) => void writes.push(d) },
    idleWaiter: new IdleWaiter(),
    stdinReady: new ReadyManager(),
    nextStdout: new ReadyManager(),
    screen: () => screen,
  };
  return { ctx, writes, setScreen: (s: string) => (screen = s) };
}

describe("sendEnter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retries a swallowed Enter when only title-spinner bytes arrive", async () => {
    const { ctx, writes } = harness();
    const done = sendEnter(ctx, 0);
    await vi.advanceTimersByTimeAsync(200);
    expect(writes).toEqual(["\r"]);
    ctx.nextStdout.ready(); // OSC title tick: bytes, but the screen is unchanged
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(writes).toEqual(["\r", "\r", "\r"]);
  });

  it("does not press again once the screen changes", async () => {
    const { ctx, writes, setScreen } = harness();
    const done = sendEnter(ctx, 0);
    await vi.advanceTimersByTimeAsync(200);
    setScreen("⏺ Bash(grep …)");
    ctx.nextStdout.ready();
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(writes).toEqual(["\r"]);
  });

  it("falls back to any stdout without a screen", async () => {
    const { ctx, writes } = harness();
    ctx.screen = undefined;
    const done = sendEnter(ctx, 0);
    await vi.advanceTimersByTimeAsync(200);
    ctx.nextStdout.ready();
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(writes).toEqual(["\r"]);
  });
});
