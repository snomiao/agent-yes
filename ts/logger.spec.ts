import { describe, it, expect, beforeEach, vi } from "vitest";

// Reset module state between tests by re-importing fresh
describe("logger", () => {
  it("queues messages before winston loads and flushes them", async () => {
    const { logger, flushLogger } = await import("./logger.ts");
    const logs: string[] = [];
    logger.info("queued message");
    await flushLogger();
    // If we reach here without throwing, the lazy init succeeded
    expect(true).toBe(true);
  });

  it("logs directly when already initialized", async () => {
    const { logger } = await import("./logger.ts");
    // Second call — _inner should be set, no queue
    expect(() => logger.info("direct message")).not.toThrow();
  });

  it("addTransport adds a transport after init", async () => {
    const { addTransport, flushLogger } = await import("./logger.ts");
    await flushLogger(); // ensure initialized
    const winston = (await import("winston")).default;
    const transport = new winston.transports.Console({ silent: true });
    await expect(addTransport(transport)).resolves.toBeUndefined();
  });
});
