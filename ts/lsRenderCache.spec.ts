import { appendFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";

// `ay ls`'s cross-run render cache: persisted under AGENT_YES_HOME, keyed by the log's state, never stale.
const home = mkdtempSync(path.join(tmpdir(), "ay-ls-cache-"));
const prevHome = process.env.AGENT_YES_HOME;
process.env.AGENT_YES_HOME = home;
afterAll(() => {
  if (prevHome === undefined) delete process.env.AGENT_YES_HOME;
  else process.env.AGENT_YES_HOME = prevHome;
});

describe("ls render disk cache", () => {
  it("persists rendered tails (0600) and never serves a changed log from the cache", async () => {
    const { enableRenderDiskCache, renderLogTailLines, saveRenderDisk } =
      await import("./subcommands.ts");
    enableRenderDiskCache();
    const log = path.join(home, "agent.log");
    writeFileSync(log, "first line\r\nsecond line\r\n");
    expect(await renderLogTailLines(log, 40)).toEqual(["first line", "second line"]);
    saveRenderDisk();
    const file = path.join(home, "cache", "ls-render.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, string[]>;
    expect(Object.values(saved)).toContainEqual(["first line", "second line"]);
    expect(await renderLogTailLines(log, 40)).toEqual(["first line", "second line"]); // reused, same lines
    appendFileSync(log, "third line\r\n");
    expect(await renderLogTailLines(log, 40)).toEqual(["first line", "second line", "third line"]);
  });
});
