import { appendFile, mkdtemp, mkdir, rm } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatHlc } from "./hlc.ts";
import { makeOp, type Op } from "./op.ts";
import { appendOps, channelFilePath, readOps } from "./store.node.ts";

function op(author: string, ms: number, body: string): Op {
  return makeOp({
    author,
    name: author,
    role: "human",
    hlc: formatHlc(ms, 0, author),
    kind: "msg",
    body,
  });
}

describe("store.node jsonl backend", () => {
  let cwd: string;
  const CH = "abc123";

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "ay-ch-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("colocates the replica under <cwd>/.agent-yes", () => {
    expect(channelFilePath("/x", CH)).toBe(path.join("/x", ".agent-yes", "ch-abc123.jsonl"));
  });

  it("returns [] for a channel with no file yet", async () => {
    expect(await readOps(cwd, CH)).toEqual([]);
  });

  it("appends and reads back, sorted by HLC", async () => {
    const added = await appendOps(cwd, CH, [op("b", 2, "two"), op("a", 1, "one")]);
    expect(added).toHaveLength(2);
    expect((await readOps(cwd, CH)).map((o) => o.body)).toEqual(["one", "two"]);
  });

  it("dedups already-stored ops on append (idempotent replica)", async () => {
    const first = op("a", 1, "one");
    await appendOps(cwd, CH, [first]);
    const added = await appendOps(cwd, CH, [first, op("a", 2, "two")]);
    expect(added.map((o) => o.body)).toEqual(["two"]); // only the new one
    expect(await readOps(cwd, CH)).toHaveLength(2);
  });

  it("drops invalid ops instead of storing them", async () => {
    // @ts-expect-error deliberately malformed
    const added = await appendOps(cwd, CH, [{ id: "x", kind: "msg" }]);
    expect(added).toEqual([]);
    expect(await readOps(cwd, CH)).toEqual([]);
  });

  it("skips corrupt/partial lines when reading", async () => {
    const good = op("a", 1, "one");
    await appendOps(cwd, CH, [good]);
    // simulate a torn write: a half-line + a non-op JSON line
    await appendFile(channelFilePath(cwd, CH), `{"not":"an op"}\n{oops not json\n\n`);
    const ops = await readOps(cwd, CH);
    expect(ops.map((o) => o.body)).toEqual(["one"]);
  });

  it("returns [] when the ops list is entirely invalid", async () => {
    // appendOps with an empty list is a no-op
    expect(await appendOps(cwd, CH, [])).toEqual([]);
    // reading a fresh channel dir that exists but has no file
    await mkdir(path.join(cwd, ".agent-yes"), { recursive: true });
    expect(await readOps(cwd, "never-written")).toEqual([]);
  });
});
