import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGlobalPids } from "../globalPidIndex.ts";

const cli = path.resolve("ts/cli.ts");
const native = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--replay-user-messages",
  "--model",
  "example",
  "Exact task",
];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(process.platform === "win32")("native stream lifecycle", () => {
  let cwd: string;
  let home: string;
  let capture: string;
  let oldHome: string | undefined;
  const children: ChildProcess[] = [];
  const records = async () => {
    const text = await readFile(path.join(home, "pids.jsonl"), "utf8").catch(() => "");
    const byPid = new Map();
    for (const line of text.trim().split("\n")) {
      try {
        const record = JSON.parse(line);
        byPid.set(record.pid, record);
      } catch {}
    }
    return [...byPid.values()].filter((record) => record.wrapper_pid !== 1111);
  };
  const idle = async () => {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      const record = (await records()).find((record) => record.status === "idle");
      if (record) return record;
      await delay(25);
    }
    throw new Error("stream did not register and become idle");
  };
  const launch = (args: string[]) => {
    const child = spawn("bun", [cli, ...args], {
      cwd,
      env: {
        ...process.env,
        AGENT_YES_HOME: home,
        AGENT_YES_PID: "1111",
        AGENT_YES_ATTACH: "0",
        AGENT_YES_NO_UPDATE: "1",
        AGENT_YES_NO_CWD_WARN: "1",
        AY_STREAM_TEST_CAPTURE: capture,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let out = "",
      err = "";
    child.stdout!.on("data", (data) => {
      out += data.toString();
    });
    child.stderr!.on("data", (data) => {
      err += data.toString();
    });
    const exited = new Promise<number | null>((resolve) =>
      child.once("exit", (code) => resolve(code)),
    );
    return { child, exited, output: () => out, error: () => err };
  };
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "ay-stream-lifecycle-"));
    home = path.join(cwd, "home");
    capture = path.join(cwd, "input.jsonl");
    oldHome = process.env.AGENT_YES_HOME;
    process.env.AGENT_YES_HOME = home;
    await mkdir(home);
    // A discoverable parent would trigger PTY init-envelope decoration on the wrong path.
    await writeFile(
      path.join(home, "pids.jsonl"),
      JSON.stringify({
        pid: process.pid,
        wrapper_pid: 1111,
        cli: "claude",
        cwd,
        status: "active",
        started_at: Date.now(),
        log_file: null,
        prompt: null,
        exit_code: null,
        exit_reason: null,
      }) + "\n",
    );
    const mock = path.join(cwd, "mock-claude");
    await copyFile(new URL("./fixtures/strict-claude.cjs", import.meta.url), mock);
    await chmod(mock, 0o755);
    await writeFile(
      path.join(cwd, ".agent-yes.config.json"),
      JSON.stringify({ clis: { claude: { binary: mock } } }),
    );
  });
  afterEach(async () => {
    for (const record of await records()) {
      try {
        process.kill(record.wrapper_pid, "SIGTERM");
      } catch {}
      try {
        process.kill(-record.pid, "SIGTERM");
      } catch {}
    }
    for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGTERM");
    await delay(100);
    if (oldHome === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = oldHome;
    await rm(cwd, { recursive: true, force: true });
  });
  it("detects native flags after the wrapper separator, keeps the task plain and mirrors idle", async () => {
    const run = launch(["claude", "--", ...native]);
    const record = await idle();
    expect(record.mode).toBe("stream");
    const messages = (await readFile(capture, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(messages[0].message.content).toBe("Exact task");
    expect(await readFile(record.log_file, "utf8")).toContain("assistant: Exact task");
    expect(run.error()).not.toContain("Invalid stream input JSON");
  });
  it("detaches a TS stream wrapper and returns the registered CLI pid", async () => {
    const run = launch(["--detach", "claude", ...native]);
    expect(await Promise.race([run.exited, delay(7000).then(() => "timeout")])).toBe(0);
    const record = await idle();
    expect(run.output()).toContain(`pid ${record.pid}`);
    expect(record.mode).toBe("stream");
    expect(record.pid).not.toBe(record.wrapper_pid);
  });
  it("recovers stream mode after a legacy registry rewrite drops unknown fields", async () => {
    launch(["claude", ...native]);
    const record = await idle();
    delete record.mode;
    await writeFile(path.join(home, "pids.jsonl"), JSON.stringify(record) + "\n");
    expect((await readGlobalPids()).find((row) => row.pid === record.pid)?.mode).toBe("stream");
    // A stale events file from a reused pid must not turn a fresh PTY record into stream.
    await appendFile(
      path.join(home, "pids.jsonl"),
      JSON.stringify({ ...record, started_at: Date.now() + 5000 }) + "\n",
    );
    expect((await readGlobalPids()).find((row) => row.pid === record.pid)?.mode).toBeUndefined();
  });
});
