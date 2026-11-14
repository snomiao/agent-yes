import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  classifyComposer,
  findRecentDuplicate,
  noteRecentSend,
  pendingDir,
  promptRe,
  readPending,
  recentSendsPath,
  rowsFromXterm,
  stripPromptGlyph,
} from "./composerGuard.ts";

describe("composer and pending-input recovery edges", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "ay-composer-edges-"));
    vi.stubEnv("AGENT_YES_HOME", root);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  it("recognizes ASCII prompts only for agy while preserving quoted transcript text", () => {
    expect(stripPromptGlyph("  > hello", "agy")).toBe("hello");
    expect(stripPromptGlyph("  > quote", "claude")).toBe("  > quote");
    expect(stripPromptGlyph("  ❯ hello")).toBe("hello");
    expect(promptRe("agy").test("> hi")).toBe(true);
    expect(promptRe("claude").test("> quote")).toBe(false);
    expect(promptRe().test("› hi")).toBe(true);
  });
  it("tolerates absent or mismatched terminal cells without losing a real draft", () => {
    const cell = { ch: "x", dim: false, inverse: false, colored: false };
    expect(
      classifyComposer([
        { text: "❯", cells: [] },
        { text: "", cells: [] },
      ]),
    ).toEqual({ kind: "empty", ghost: false });
    expect(classifyComposer([{ text: "❯", cells: [cell] }])).toEqual({ kind: "draft", chars: 1 });
  });
  it("handles sparse terminal rows, missing cells and wide-character continuation cells", () => {
    const char = (value: string, width = 1) => ({
      getWidth: () => width,
      getChars: () => value,
      isDim: () => 0,
      isInverse: () => 0,
      isFgDefault: () => true,
      isFgPalette: () => false,
      getFgColor: () => 0,
    });
    const line = {
      length: 4,
      translateToString: () => "x",
      getCell: (x: number) => [char("x"), undefined, char("", 0), char("")][x],
    };
    const term = {
      buffer: { active: { length: 3, getLine: (i: number) => (i === 1 ? line : undefined) } },
    };
    const rows = rowsFromXterm(term as never, 3);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ text: "", cells: [] });
    expect(rows[1]?.cells.map((c) => c.ch)).toEqual(["x", " "]);
    expect(rowsFromXterm(term as never, 3, true)).toEqual(rows);
    expect(
      rowsFromXterm(
        { buffer: { active: { length: 1, getLine: () => undefined } } } as never,
        3,
        true,
      ),
    ).toEqual([]);
  });
  it("returns no pending message for missing or torn queue files", async () => {
    expect(await readPending(1111, "missing.json")).toBeNull();
    await mkdir(pendingDir(1111), { recursive: true });
    await writeFile(path.join(pendingDir(1111), "torn.json"), "{");
    expect(await readPending(1111, "torn.json")).toBeNull();
  });
  it("ignores corrupt dedupe ledger lines and prunes entries older than the resend window", async () => {
    const file = recentSendsPath(1111);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{torn\n\n{"at":0,"sender":"old","hash":"x","outcome":"sent"}\n');
    expect(await findRecentDuplicate(1111, "new", "hello", 100000)).toBeNull();
    await noteRecentSend(1111, "new", "hello", "sent", 100000);
    expect(await findRecentDuplicate(1111, "new", "hello", 100001)).toMatchObject({
      sender: "new",
      outcome: "sent",
    });
  });
});
