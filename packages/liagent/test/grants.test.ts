import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantStore, spillTo } from "../src/grants.ts";

const root = mkdtempSync(join(tmpdir(), "liagent-grants-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const mode = (p: string) => statSync(p).mode & 0o777;

test("the grants file is 0600 in a 0700 directory, from its first write", () => {
  const file = join(root, "a", "b", "grants.json");
  const g = grantStore(file);
  g.save("https://dev.example.com/api/chat", "chat", "t1", Date.now() + 1000);
  expect(mode(file)).toBe(0o600);
  expect(mode(join(root, "a", "b"))).toBe(0o700);
  expect(g.load("https://dev.example.com/api/chat", "chat")).toBe("t1");
  expect(g.load("https://dev.example.com/api/chat", "eval")).toBeUndefined();
  g.save("https://dev.example.com/api/chat", "eval", "t2", Date.now() + 1000);
  expect(g.load("https://dev.example.com/api/chat", "eval")).toBe("t2");
  g.forget("https://dev.example.com/api/chat", "chat");
  expect(g.load("https://dev.example.com/api/chat", "chat")).toBeUndefined();
  expect(mode(file)).toBe(0o600);
});

test("an existing loose directory and file are tightened", () => {
  const dir = join(root, "loose");
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  const file = join(dir, "grants.json");
  writeFileSync(file, "{}", { mode: 0o644 });
  chmodSync(file, 0o644);
  grantStore(file).save("h", "chat", "t", Date.now());
  expect(mode(dir)).toBe(0o700);
  expect(mode(file)).toBe(0o600);
});

test("inbox files are 0600 in a 0700 directory", () => {
  const p = spillTo(join(root, "inbox"), "ab/c", "long text");
  expect(p.endsWith("ab_c.txt")).toBe(true);
  expect(mode(p)).toBe(0o600);
  expect(mode(join(root, "inbox"))).toBe(0o700);
});
