import { describe, expect, it } from "vitest";
import { IdleWaiter } from "./idleWaiter";

describe("IdleWaiter", () => {
  it("should initialize with current time", () => {
    const waiter = new IdleWaiter();
    expect(waiter.lastActivityTime).toBeCloseTo(Date.now(), -2);
  });

  it("should update lastActivityTime when ping is called", () => {
    const waiter = new IdleWaiter();
    const initialTime = waiter.lastActivityTime;

    // Wait a small amount
    const start = Date.now();
    while (Date.now() - start < 10) {
      // busy wait
    }

    waiter.ping();
    expect(waiter.lastActivityTime).toBeGreaterThan(initialTime);
  });

  it("should return this when ping is called for chaining", () => {
    const waiter = new IdleWaiter();
    expect(waiter.ping()).toBe(waiter);
  });

  it("should resolve wait immediately when already idle", async () => {
    const waiter = new IdleWaiter();

    // Wait enough time to be considered idle
    const start = Date.now();
    while (Date.now() - start < 50) {
      // busy wait
    }

    // This should resolve quickly since enough time has passed
    const waitPromise = waiter.wait(10);
    await expect(waitPromise).resolves.toBeUndefined();
  });

  it("should respect custom check interval", () => {
    const waiter = new IdleWaiter();
    waiter.checkInterval = 200;

    expect(waiter.checkInterval).toBe(200);
  });

  it("should have ping method that chains", () => {
    const waiter = new IdleWaiter();
    const result = waiter.ping().ping().ping();
    expect(result).toBe(waiter);
  });

  it("should wait until idle period has passed", async () => {
    const waiter = new IdleWaiter();
    waiter.checkInterval = 10;

    // Ping right now so it's not idle
    waiter.ping();

    const start = Date.now();
    // Wait for 50ms idle period — the wait loop should actually iterate
    await waiter.wait(50);
    const elapsed = Date.now() - start;

    // Should have waited at least ~50ms
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });
});
