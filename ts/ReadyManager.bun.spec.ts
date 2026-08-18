import { describe, expect, it } from "bun:test";
import { ReadyManager } from "./ReadyManager";

describe("ReadyManager", () => {
  it("should start in not ready state", () => {
    const manager = new ReadyManager();
    expect(manager.wait()).toBeInstanceOf(Promise);
  });

  it("should resolve wait when ready is called", async () => {
    const manager = new ReadyManager();
    const waitPromise = manager.wait();

    manager.ready();

    await expect(waitPromise).resolves.toBeUndefined();
  });

  it("should resolve immediately if already ready", async () => {
    const manager = new ReadyManager();
    manager.ready();

    const result = manager.wait();
    expect(result).toBeUndefined();
  });

  it("should handle multiple waiters", async () => {
    const manager = new ReadyManager();
    const wait1 = manager.wait();
    const wait2 = manager.wait();
    const wait3 = manager.wait();

    manager.ready();

    await Promise.all([
      expect(wait1).resolves.toBeUndefined(),
      expect(wait2).resolves.toBeUndefined(),
      expect(wait3).resolves.toBeUndefined(),
    ]);
  });

  it("should reset to not ready when unready is called", async () => {
    const manager = new ReadyManager();
    manager.ready();
    manager.unready();

    expect(manager.wait()).toBeInstanceOf(Promise);
  });

  it("should handle ready with no waiting queue", () => {
    const manager = new ReadyManager();
    manager.ready(); // Should not throw even if no one is waiting
    expect(manager.wait()).toBeUndefined(); // Should be ready now
  });

  it("should handle multiple ready/unready cycles", async () => {
    const manager = new ReadyManager();

    // First cycle
    const wait1 = manager.wait();
    manager.ready();
    await wait1;

    // Reset
    manager.unready();

    // Second cycle
    const wait2 = manager.wait();
    manager.ready();
    await expect(wait2).resolves.toBeUndefined();
  });
});
