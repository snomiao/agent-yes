import { afterEach, beforeEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { pgidForWrapper, register, sweep } from "./reaper.ts";

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

test("sweep prunes activity markers of dead pids and keeps live ones", async () => {
  const activityDir = path.join(process.env.AGENT_YES_HOME!, "activity");
  mkdirSync(activityDir, { recursive: true });
  const live = path.join(activityDir, `${process.pid}.stdin`); // our own pid = alive
  const dead = path.join(activityDir, `999999.stdin`); // not a running process
  const junk = path.join(activityDir, `not-a-marker.txt`); // ignored (no .stdin pid)
  writeFileSync(live, String(Date.now()));
  writeFileSync(dead, String(Date.now()));
  writeFileSync(junk, "x");

  await sweep();

  expect(existsSync(live)).toBe(true); // alive → kept
  expect(existsSync(dead)).toBe(false); // dead → pruned
  expect(existsSync(junk)).toBe(true); // non-marker file untouched
});

test("register refuses to persist a pgid <= 1", async () => {
  await register(process.pid, 1);
  await register(process.pid, 0);
  // Nothing written, so the registry file doesn't exist — sweep is a no-op.
  await sweep();
  expect(() => readFileSync(registryFile(), "utf8")).toThrow();
});

test("pgidForWrapper returns the newest matching pgid, ignoring junk + bad entries", async () => {
  writeFileSync(
    registryFile(),
    [
      JSON.stringify({ wpid: 4242, pgid: 100 }),
      "not-json", // malformed → skipped, not thrown
      "", // blank → skipped
      JSON.stringify({ wpid: 9999, pgid: 200 }), // different wrapper → ignored for 4242
      JSON.stringify({ wpid: 4242, pgid: 1 }), // pgid <= 1 → ignored
      JSON.stringify({ wpid: 4242, pgid: 300 }), // newest valid for 4242 → wins
    ].join("\n") + "\n",
  );
  expect(await pgidForWrapper(4242)).toBe(300);
  expect(await pgidForWrapper(9999)).toBe(200);
  expect(await pgidForWrapper(1234)).toBeNull(); // no entry for this wrapper
});

test("pgidForWrapper returns null for an invalid wpid or a missing registry", async () => {
  expect(await pgidForWrapper(0)).toBeNull(); // !wpid
  expect(await pgidForWrapper(1)).toBeNull(); // wpid <= 1 (never ppid==1)
  // Fresh home, no registry file written → readFile throws → null (not a crash).
  expect(await pgidForWrapper(4242)).toBeNull();
});
