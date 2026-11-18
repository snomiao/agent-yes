import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runStream } from "./runner.ts";

it.skipIf(process.platform === "win32")(
  "reports an incomplete capture instead of hanging on an escaped writer",
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "ay-stream-drain-timeout-"));
    const previous = process.env.AGENT_YES_HOME;
    process.env.AGENT_YES_HOME = cwd;
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let escaped: number | undefined;
    try {
      const pidFile = path.join(cwd, "escaped.pid");
      const entry = path.join(cwd, "parent.cjs");
      const worker = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
      await writeFile(
        entry,
        `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{detached:true,stdio:'inherit'});const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(pidFile)})){clearInterval(timer);process.exit(0);}},10);`,
      );
      const began = Date.now();
      expect(
        await runStream({
          cwd,
          cli: "claude",
          binary: process.execPath,
          cliArgs: [entry],
          outputDrainTimeoutMs: 150,
        }),
      ).toBe(1);
      expect(Date.now() - began).toBeLessThan(3000);
      escaped = Number(await readFile(pidFile, "utf8"));
      const record = JSON.parse(
        (await readFile(path.join(cwd, "pids.jsonl"), "utf8")).trim().split("\n").at(-1)!,
      );
      expect(record).toMatchObject({ exit_code: 1, exit_reason: "stream-output-error" });
      expect(await readFile(record.log_file, "utf8")).toContain("Timed out draining stream output");
    } finally {
      if (!escaped)
        escaped = Number(await readFile(path.join(cwd, "escaped.pid"), "utf8").catch(() => "0"));
      if (escaped)
        try {
          process.kill(-escaped, "SIGKILL");
        } catch {}
      out.mockRestore();
      if (previous === undefined) delete process.env.AGENT_YES_HOME;
      else process.env.AGENT_YES_HOME = previous;
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
