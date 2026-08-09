import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { cmdHist, renderRecord, snippet } from "./hist.ts";
import { encodeProjectSlug, type HistRecord } from "./histStore.ts";

let testHome: string;

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    homedir: () => testHome,
  };
});

beforeEach(async () => {
  testHome = await mkdtemp(path.join(tmpdir(), "ay-hist-test-"));
});

afterEach(async () => {
  await rm(testHome, { recursive: true, force: true }).catch(() => null);
});

const rec: HistRecord = {
  ts: "2026-08-06T09:29:37.533Z",
  role: "user",
  text: "hello there",
  source: "claude",
  sessionId: "ff1f38ee-78aa-48a6",
  file: "/tmp/x.jsonl",
  offset: 0,
};

describe("snippet", () => {
  it("leaves short text alone", () => {
    expect(snippet("short", 100)).toBe("short");
  });

  it("truncates and reports what was withheld", () => {
    const out = snippet("a".repeat(50) + "\n" + "b".repeat(50), 10);
    expect(out.startsWith("a".repeat(10))).toBe(true);
    expect(out).toContain("+91 chars");
    expect(out).toContain("2 more lines");
  });

  it("treats max 0 as unlimited, for --full", () => {
    const long = "x".repeat(5000);
    expect(snippet(long, 0)).toBe(long);
  });
});

describe("renderRecord", () => {
  it("labels the human as user and the agent by its source", () => {
    expect(renderRecord(rec, { color: false, max: 0 })).toContain("user");
    expect(renderRecord({ ...rec, role: "assistant" }, { color: false, max: 0 })).toContain(
      "claude",
    );
    expect(
      renderRecord({ ...rec, role: "assistant", source: "codex" }, { color: false, max: 0 }),
    ).toContain("codex");
  });

  it("emits no ANSI when color is off, so pipes stay clean", () => {
    const out = renderRecord(rec, { color: false, max: 0 });
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(out)).toBe(false);
  });

  it("stays ANSI-free when color is off AND the turn is truncated", () => {
    // The truncation note carried hardcoded dim/reset, so `ay hist | cat` leaked
    // escapes on exactly the turns long enough to be shortened. The max:0 case
    // above never truncates, so it cannot catch this.
    const out = renderRecord({ ...rec, text: "x".repeat(900) }, { color: false, max: 600 });
    expect(out).toContain("(+300 chars");
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(out)).toBe(false);
  });

  it("still tints the truncation note when color is on", () => {
    const out = renderRecord({ ...rec, text: "x".repeat(900) }, { color: true, max: 600 });
    expect(out).toContain(`${"\x1b[2m"}(+300 chars`);
  });

  it("colors user and agent turns differently when color is on", () => {
    const user = renderRecord(rec, { color: true, max: 0 });
    const agent = renderRecord({ ...rec, role: "assistant" }, { color: true, max: 0 });
    expect(user).toContain("\x1b[36m");
    expect(agent).toContain("\x1b[32m");
  });

  it("indents the body and shows a short session id", () => {
    const out = renderRecord(rec, { color: false, max: 0 });
    expect(out).toContain("\n  hello there");
    expect(out).toContain("ff1f38ee");
    expect(out).not.toContain("ff1f38ee-78aa");
  });

  it("survives a missing timestamp", () => {
    expect(renderRecord({ ...rec, ts: null }, { color: false, max: 0 })).toContain("??:??");
  });

  it("renders an unparseable timestamp as ??:??", () => {
    expect(renderRecord({ ...rec, ts: "not-a-date" }, { color: false, max: 0 })).toContain("??:??");
  });

  it("shows a bare HH:MM for a same-day timestamp and MM-DD for older ones", () => {
    const today = renderRecord({ ...rec, ts: new Date().toISOString() }, { color: false, max: 0 });
    expect(today).not.toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
    const old = renderRecord({ ...rec, ts: "2020-01-02T03:04:05.000Z" }, { color: false, max: 0 });
    expect(old).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
  });
});

describe("cmdHist", () => {
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stdout as any).write = (s: any) => (out.push(String(s)), true);
    (process.stderr as any).write = (s: any) => (err.push(String(s)), true);
    return {
      out,
      err,
      restore() {
        process.stdout.write = origOut;
        process.stderr.write = origErr;
      },
    };
  }

  /** Drop a two-turn Claude transcript for `cwd` under the mocked home. */
  async function writeClaudeFixture(cwd: string) {
    const dir = path.join(testHome, ".claude", "projects", encodeProjectSlug(cwd));
    await mkdir(dir, { recursive: true });
    const lines = [
      JSON.stringify({
        type: "user",
        timestamp: "2026-08-06T09:00:00.000Z",
        message: { role: "user", content: "fix the bug" },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-06T09:00:05.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "done, tests pass" }] },
      }),
    ];
    await writeFile(path.join(dir, "ff1f38ee-78aa-48a6.jsonl"), lines.join("\n") + "\n");
  }

  it("exits 1 with guidance when the scoped cwd has no history", async () => {
    const cap = capture();
    try {
      expect(await cmdHist(["--cwd", path.join(testHome, "nowhere")])).toBe(1);
      expect(cap.err.join("")).toContain("no agent conversation history for");
      expect(cap.err.join("")).toContain("ay hist --all");
    } finally {
      cap.restore();
    }
  });

  it("exits 1 without the --all hint when already unscoped", async () => {
    const cap = capture();
    try {
      expect(await cmdHist(["--all"])).toBe(1);
      expect(cap.err.join("")).toContain("on this machine");
      expect(cap.err.join("")).not.toContain("ay hist --all");
    } finally {
      cap.restore();
    }
  });

  it("--json emits one JSONL record per turn (and exits 1 on empty)", async () => {
    const cap = capture();
    try {
      expect(await cmdHist(["--all", "--json"])).toBe(1);
      expect(cap.out.join("")).toBe("");
      await writeClaudeFixture("/repo/demo");
      expect(await cmdHist(["--all", "--json"])).toBe(0);
      const records = cap.out
        .join("")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(records.length).toBe(2);
      expect(records.map((r) => r.role).sort()).toEqual(["assistant", "user"]);
    } finally {
      cap.restore();
    }
  });

  it("renders turns and prints a pagination cursor when older turns remain", async () => {
    await writeClaudeFixture("/repo/demo");
    const cap = capture();
    try {
      expect(await cmdHist(["--cwd", "/repo/demo", "-n", "1"])).toBe(0);
      expect(cap.out.join("")).toContain("done, tests pass");
      expect(cap.err.join("")).toContain("older: ay hist --before ");
    } finally {
      cap.restore();
    }
  });

  it("--source/--role/--full/--tools narrow and widen the page", async () => {
    await writeClaudeFixture("/repo/demo");
    const cap = capture();
    try {
      expect(
        await cmdHist([
          "--all",
          "--source",
          "claude",
          "--role",
          "user",
          "--full",
          "--tools",
          "--sidechains",
          "--json",
        ]),
      ).toBe(0);
      const records = cap.out
        .join("")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(records.every((r) => r.role === "user")).toBe(true);
      expect(await cmdHist(["--all", "--source", "codex", "--json"])).toBe(1);
    } finally {
      cap.restore();
    }
  });
});
