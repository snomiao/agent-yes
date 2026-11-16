import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ClaudeAdapter } from "./claude.ts";

it("frames user input, permission replies and interrupts without injecting native flags", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ay-claude-pipes-"));
  const adapter = new ClaudeAdapter();
  expect(() => adapter.send("unconnected")).toThrow("not writable");
  await expect(adapter.interrupt()).rejects.toThrow("not writable");
  expect(() => adapter.answer("unknown", "allow")).toThrow("Unknown Claude permission request");
  let child: ReturnType<ClaudeAdapter["spawn"]> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const entry = path.join(cwd, "protocol.cjs");
    await writeFile(
      entry,
      `const readline = require('node:readline');
const lines = [];
const input = readline.createInterface({input:process.stdin});
input.on('line', line => lines.push(JSON.parse(line)));
input.on('close', () => console.log(JSON.stringify({argv:process.argv.slice(2),lines})));`,
    );
    child = adapter.spawn({
      cwd,
      binary: process.execPath,
      args: [entry, "--native-option", "value"],
      resumeId: "example-session",
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data.toString();
    });
    child.stderr.resume();
    const done = new Promise<void>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`fixture exited ${code}`)),
      );
      timer = setTimeout(() => {
        child!.kill("SIGTERM");
        reject(new Error("protocol fixture timed out"));
      }, 5000);
    });
    const firstId = adapter.send("first\nline", "00000000-0000-4000-8000-000000000001");
    const secondId = adapter.send("second task");
    for (const choice of ["allow", "deny"]) {
      adapter.parse(
        JSON.stringify({
          type: "control_request",
          request_id: choice,
          request: {
            subtype: "can_use_tool",
            tool_name: "Bash",
            input: { command: "printf hello" },
          },
        }),
      );
      adapter.answer(choice, choice);
    }
    await adapter.interrupt();
    child.stdin.end();
    await done;
    const result = JSON.parse(output.trim());
    expect(result.argv).toEqual(["--native-option", "value", "--resume", "example-session"]);
    expect(result.lines).toHaveLength(5);
    expect(result.lines[0]).toMatchObject({
      type: "user",
      uuid: firstId,
      message: { role: "user", content: "first\nline" },
    });
    expect(result.lines[1]).toMatchObject({
      type: "user",
      uuid: secondId,
      message: { role: "user", content: "second task" },
    });
    expect(result.lines[2]).toMatchObject({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "allow",
        response: { behavior: "allow", updatedInput: { command: "printf hello" } },
      },
    });
    expect(result.lines[3]).toMatchObject({
      type: "control_response",
      response: { request_id: "deny", response: { behavior: "deny", message: "deny" } },
    });
    expect(result.lines[4]).toMatchObject({
      type: "control_request",
      request: { subtype: "interrupt" },
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (child && child.exitCode === null) child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
