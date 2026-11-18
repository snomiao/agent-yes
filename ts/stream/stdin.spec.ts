import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform === "win32")(
  "forwards piped text unchanged into output-only native stream capture",
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "ay-stream-stdin-"));
    let child: ReturnType<typeof spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const mock = path.join(cwd, "mock-claude");
      await writeFile(
        mock,
        `#!/usr/bin/env node
const chunks=[];
process.stdin.on('data',chunk=>chunks.push(chunk));
process.stdin.on('end',()=>{
console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:Buffer.concat(chunks).toString('utf8')}]}}));
console.log(JSON.stringify({type:'result',is_error:false}));
});`,
      );
      await chmod(mock, 0o755);
      await writeFile(
        path.join(cwd, ".agent-yes.config.json"),
        JSON.stringify({ clis: { claude: { binary: mock } } }),
      );
      child = spawn(
        "bun",
        [path.resolve("ts/cli.ts"), "claude", "-p", "--output-format", "stream-json", "--verbose"],
        {
          cwd,
          env: {
            ...process.env,
            AGENT_YES_HOME: path.join(cwd, "home"),
            AGENT_YES_ATTACH: "1",
            AGENT_YES_NO_UPDATE: "1",
            AGENT_YES_NO_CWD_WARN: "1",
          },
          stdio: "pipe",
        },
      );
      let output = "",
        error = "";
      child.stdout!.on("data", (data) => {
        output += data.toString();
      });
      child.stderr!.on("data", (data) => {
        error += data.toString();
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        child!.once("error", reject);
        child!.once("exit", resolve);
        timer = setTimeout(() => {
          child!.kill("SIGTERM");
          reject(new Error("output-only input timed out"));
        }, 5000);
      });
      const text = "first line\nsecond line \u2603\n";
      const bytes = Buffer.from(text);
      child.stdin!.write(bytes.subarray(0, bytes.length - 2));
      child.stdin!.end(bytes.subarray(bytes.length - 2));
      expect(await exited, error).toBe(0);
      expect(output).toContain(`assistant: ${text}`);
    } finally {
      if (timer) clearTimeout(timer);
      if (child && child.exitCode === null) child.kill("SIGTERM");
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
