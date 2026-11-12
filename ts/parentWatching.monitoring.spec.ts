import { afterEach, describe, expect, it, vi } from "vitest";
const dependencies = vi.hoisted(() => ({
  watchers: vi.fn<() => Promise<Map<number, number>>>(),
  lastReadAt: vi.fn<() => Promise<number | null>>(),
}));
vi.mock("./notifyStore.ts", () => ({ liveWatchers: dependencies.watchers }));
vi.mock("./subcommands.ts", () => ({ lastReadAt: dependencies.lastReadAt, READ_WINDOW_MS: 60000 }));
import { isParentWatching } from "./parentWatching.ts";
afterEach(() => {
  vi.resetAllMocks();
});

describe("parent monitoring fail-open policy", () => {
  it("suppresses duplicate reports while an explicit watcher is live", async () => {
    dependencies.watchers.mockResolvedValue(new Map([[1111, 100]]));
    expect(await isParentWatching(1111, 2222, 3333)).toBe(true);
    expect(dependencies.lastReadAt).not.toHaveBeenCalled();
  });
  it("recognizes recent reads of this child even without a watcher", async () => {
    dependencies.watchers.mockResolvedValue(new Map());
    dependencies.lastReadAt.mockResolvedValue(10000);
    expect(await isParentWatching(1111, 2222, 3333, 20000)).toBe(true);
    expect(dependencies.lastReadAt).toHaveBeenCalledWith("agent:2222", 3333);
    expect(await isParentWatching(1111, 2222, 3333, 80000)).toBe(false);
  });
  it("still checks read recency if the watcher store is unavailable", async () => {
    dependencies.watchers.mockRejectedValue(new Error("unreadable watcher store"));
    dependencies.lastReadAt.mockResolvedValue(10000);
    expect(await isParentWatching(1111, 2222, 3333, 20000)).toBe(true);
  });
  it("allows the report if both monitoring sources fail", async () => {
    dependencies.watchers.mockRejectedValue(new Error("unreadable watcher store"));
    dependencies.lastReadAt.mockRejectedValue(new Error("unreadable read ledger"));
    expect(await isParentWatching(1111, 2222, 3333, 20000)).toBe(false);
  });
});
