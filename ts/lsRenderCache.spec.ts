import { appendFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";
import {
  enableRenderDiskCache,
  extractTaskCounts,
  renderLogTailLines,
  resetRenderDiskCache,
  saveRenderDisk,
} from "./subcommands.ts";

// `ay ls`'s cross-run render cache: persisted under AGENT_YES_HOME, keyed by the log's state, never stale.
const home = mkdtempSync(path.join(tmpdir(), "ay-ls-cache-"));
const prevHome = process.env.AGENT_YES_HOME;
process.env.AGENT_YES_HOME = home;
enableRenderDiskCache(); // the destination is fixed here, inside the temp home
afterAll(() => {
  resetRenderDiskCache(); // forget it without writing; the exit handler goes too
  if (prevHome === undefined) delete process.env.AGENT_YES_HOME;
  else process.env.AGENT_YES_HOME = prevHome;
});

const file = path.join(home, "cache", "ls-render.json");
const plant = (pick: (key: string) => boolean, value: unknown) => {
  const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  for (const k of Object.keys(saved)) if (pick(k)) saved[k] = value;
  writeFileSync(file, JSON.stringify(saved));
};
const freshRun = () => {
  // a new `ay ls` process: nothing in memory, the file read again
  resetRenderDiskCache();
  enableRenderDiskCache();
};

describe("ls render disk cache", () => {
  it("is read by the next run for an unchanged log, and never used for a changed one", async () => {
    const log = path.join(home, "agent.log");
    writeFileSync(log, "first line\r\nsecond line\r\n");
    expect(await renderLogTailLines(log, 40)).toEqual(["first line", "second line"]);
    expect(await extractTaskCounts(log)).toBeNull();
    saveRenderDisk();
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // a marker planted in the saved file comes back: the next run read the disk, it did not re-render
    plant((k) => !k.startsWith("tasks"), ["from disk"]);
    plant((k) => k.startsWith("tasks"), { done: 1, total: 2 });
    freshRun();
    expect(await renderLogTailLines(log, 40)).toEqual(["from disk"]);
    expect(await extractTaskCounts(log)).toEqual({ done: 1, total: 2 });

    // the log changes: new keys, so the real screen is rendered again
    appendFileSync(log, "third line\r\n");
    expect(await renderLogTailLines(log, 40)).toEqual(["first line", "second line", "third line"]);
    expect(await extractTaskCounts(log)).toBeNull();
  });
});
