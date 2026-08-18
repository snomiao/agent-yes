import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildPingBody, buildSendArgv, deliverPing, type PingSelf } from "./parentPingSend.ts";
import type { PingDecision } from "./parentPing.ts";

const self: PingSelf = {
  cli: "claude",
  pid: 777,
  cwd: "/repo",
  prompt: "fix the flaky test",
};
const d = (over: Partial<PingDecision> = {}): PingDecision => ({
  reason: "finished",
  attempt: 1,
  question: null,
  ...over,
});

describe("buildPingBody", () => {
  it("wraps in <ay-report …> with the child's identity", () => {
    const out = buildPingBody(d(), self);
    expect(out).toMatch(/^<ay-report from claude #777 @ \/repo>/);
    expect(out.endsWith("</ay-report>")).toBe(true);
  });

  it("says which edge fired", () => {
    expect(buildPingBody(d(), self)).toContain("looks FINISHED");
    expect(buildPingBody(d({ reason: "stuck" }), self)).toContain("is STUCK");
    expect(buildPingBody(d({ reason: "exited" }), self)).toContain("has EXITED");
  });

  it("is explicit that this is the WRAPPER talking, not the agent", () => {
    const out = buildPingBody(d(), self);
    expect(out).toContain("automatic report from its agent-yes wrapper");
    expect(out).toContain("not as its answer");
  });

  it("marks a repeat as a reminder so the parent knows it already ignored one", () => {
    expect(buildPingBody(d({ attempt: 1 }), self)).not.toContain("reminder");
    expect(buildPingBody(d({ attempt: 3 }), self)).toContain("reminder #2 — no reply yet");
  });

  it("reminds the parent what it asked for", () => {
    expect(buildPingBody(d(), self)).toContain("Task it was spawned with: fix the flaky test");
    expect(buildPingBody(d(), { ...self, prompt: null })).not.toContain("Task it was spawned with");
  });

  it("carries the question for a stuck report", () => {
    const out = buildPingBody(d({ reason: "stuck", question: "Approve edit?" }), self);
    expect(out).toContain("It is asking: Approve edit?");
  });

  it("includes the exit code only for an exit report", () => {
    expect(buildPingBody(d({ reason: "exited" }), { ...self, exitCode: 2 })).toContain(
      "Exit code: 2",
    );
    expect(buildPingBody(d({ reason: "exited" }), { ...self, exitCode: 0 })).toContain(
      "Exit code: 0",
    );
    expect(buildPingBody(d({ reason: "exited" }), { ...self, exitCode: null })).not.toContain(
      "Exit code:",
    );
  });

  it("attaches the tail as evidence, because the parent is not tailing", () => {
    const out = buildPingBody(d(), self, "  \nall tests passed\n");
    expect(out).toContain("Last output:");
    expect(out).toContain("all tests passed");
  });

  it("omits an empty tail section entirely", () => {
    expect(buildPingBody(d(), self, "   \n  ")).not.toContain("Last output:");
    expect(buildPingBody(d(), self, null)).not.toContain("Last output:");
  });

  it("clips a runaway tail on a word boundary", () => {
    const out = buildPingBody(d(), self, "word ".repeat(1000));
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(2000);
  });

  it("offers result/cat for an exited child and tail/send for a live one", () => {
    expect(buildPingBody(d({ reason: "exited" }), self)).toContain("ay result get 777");
    expect(buildPingBody(d({ reason: "stuck" }), self)).toContain(`ay send 777 "..."`);
  });
});

describe("buildSendArgv", () => {
  it("re-invokes THIS entrypoint so the ping uses the same build", () => {
    const { cmd, args } = buildSendArgv("agt_parent", "/opt/agent-yes/dist/agent-yes.js");
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual([
      "/opt/agent-yes/dist/agent-yes.js",
      "send",
      "agt_parent",
      "-",
      "--force",
      "--no-wait",
    ]);
  });

  it("falls back to `ay` on PATH when there is no argv[1]", () => {
    const { cmd, args } = buildSendArgv("agt_parent");
    expect(cmd).toBe("ay");
    expect(args[0]).toBe("send");
  });

  it("reads the body from stdin (`-`) so a multi-line report needs no escaping", () => {
    expect(buildSendArgv("x", "e.js").args).toContain("-");
  });

  it("forces past the recency guard and never blocks on the parent's screen", () => {
    const { args } = buildSendArgv("x", "e.js");
    expect(args).toContain("--force");
    expect(args).toContain("--no-wait");
  });
});

describe("deliverPing", () => {
  it("resolves false instead of throwing when the command cannot be spawned", async () => {
    const argv1 = process.argv[1];
    process.argv[1] = "/nonexistent/definitely-not-here.js";
    try {
      await expect(
        deliverPing({
          target: "x",
          body: "b",
          selfWrapperPid: 1,
          timeoutMs: 5_000,
        }),
      ).resolves.toBe(false);
    } finally {
      process.argv[1] = argv1!;
    }
  });
});

describe("deliverPing — the wire contract, against a stub `ay send`", () => {
  // Exercises the real subprocess path: what argv the stub is invoked with, what
  // arrives on its stdin, and what AGENT_YES_PID it inherits. That last one is
  // the subtle bug this guards: the wrapper's own AGENT_YES_PID is the PARENT's
  // wrapper pid, so without an override the parent would receive a report
  // apparently sent by itself.
  let dir: string;
  let out: string;
  let argv1: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ay-ping-"));
    out = path.join(dir, "captured.json");
    const stub = path.join(dir, "stub.mjs");
    writeFileSync(
      stub,
      `import { writeFileSync } from "node:fs";
       let body = "";
       process.stdin.setEncoding("utf8");
       process.stdin.on("data", (c) => (body += c));
       process.stdin.on("end", () => {
         writeFileSync(${JSON.stringify(out)}, JSON.stringify({
           args: process.argv.slice(2),
           body,
           ayPid: process.env.AGENT_YES_PID,
         }));
         process.exit(0);
       });`,
    );
    argv1 = process.argv[1];
    process.argv[1] = stub;
  });

  afterEach(() => {
    if (argv1 !== undefined) process.argv[1] = argv1;
    rmSync(dir, { recursive: true, force: true });
  });

  it("hands the report to `ay send <target> - --force --no-wait` on stdin", async () => {
    const body = buildPingBody(d({ reason: "stuck", question: "Approve?" }), self, "tail line");
    await expect(
      deliverPing({
        target: "agt_parent",
        body,
        selfWrapperPid: 4242,
        timeoutMs: 20_000,
      }),
    ).resolves.toBe(true);

    const captured = JSON.parse(readFileSync(out, "utf8"));
    expect(captured.args).toEqual(["send", "agt_parent", "-", "--force", "--no-wait"]);
    expect(captured.body).toBe(body);
    // Attributed to the CHILD's wrapper, not the inherited parent's.
    expect(captured.ayPid).toBe("4242");
  });
});
