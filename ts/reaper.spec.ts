import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { register, sweep } from "./reaper.ts";

let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.AGENT_YES_HOME;
  process.env.AGENT_YES_HOME = mkdtempSync(path.join(tmpdir(), "ay-reaper-"));
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AGENT_YES_HOME;
  else process.env.AGENT_YES_HOME = prevHome;
});

const registryFile = () => path.join(process.env.AGENT_YES_HOME!, "reaper.jsonl");
const liveLines = () =>
  readFileSync(registryFile(), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

test("sweep keeps live wrappers and drops dead ones", async () => {
  // A live wrapper (us) is kept; a dead wrapper (999999) is dropped. Neither
  // pgid points at a real group, so the kill is a harmless ESRCH no-op — we only
  // exercise the bookkeeping here, not real signalling.
  await register(process.pid, 222_222);
  await register(999_999, 999_998);
  await sweep();

  const lines = liveLines();
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain(String(process.pid));
});

test("register refuses to persist a pgid <= 1", async () => {
  await register(process.pid, 1);
  await register(process.pid, 0);
  // Nothing written, so the registry file doesn't exist — sweep is a no-op.
  await sweep();
  expect(() => readFileSync(registryFile(), "utf8")).toThrow();
});
