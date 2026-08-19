import { exec } from "child_process";
import { fromStdio } from "from-node-stream";
import sflow from "sflow";
import { describe, it } from "bun:test";
import { sleepms } from "./utils";

describe("CLI idle tests", () => {
  // 2025-08-11 ok
  it.skip("CLI --exit-on-idle flag with custom timeout", async () => {
    const p = exec(
      `bunx tsx ./ts/cli.ts claude --verbose --logFile=./cli-idle.log --exit-on-idle=3s "say hello and wait"`,
    );
    const tr = new TransformStream<string, string>();
    const output = await sflow(tr.readable).by(fromStdio(p)).log().text();
    console.log(output);
    expect(output).toContain("hello");
    await sleepms(1000); // wait for process exit
    expect(p.exitCode).toBe(0);
  }, 20e3);
});
