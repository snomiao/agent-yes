import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runStream } from "./runner.ts";

it.skipIf(process.platform === "win32")(
  "reaps same-group descendants on normal exit without waiting for inherited output pipes",
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "ay-stream-group-"));
    const previous = process.env.AGENT_YES_HOME;
    process.env.AGENT_YES_HOME = cwd;
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let descendant: number | undefined;
    try {
      const pidFile = path.join(cwd, "descendant.pid");
      const entry = path.join(cwd, "parent.cjs");
      const worker = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
      await writeFile(
        entry,
        `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:'inherit'});
const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(pidFile)})){clearInterval(timer);console.log(JSON.stringify({type:'result',is_error:false}));process.exit(0);}},10);`,
      );
      const began = Date.now();
      expect(
        await runStream({ cwd, cli: "claude", binary: process.execPath, cliArgs: [entry] }),
      ).toBe(0);
      expect(Date.now() - began).toBeLessThan(3000);
      descendant = Number(await readFile(pidFile, "utf8"));
      const running = () => {
        try {
          process.kill(descendant!, 0);
          // A reparented zombie is already dead; Linux init may reap it later.
          if (
            process.platform === "linux" &&
            /\) Z /.test(readFileSync(`/proc/${descendant}/stat`, "utf8"))
          )
            return false;
          return true;
        } catch {
          return false;
        }
      };
      const deadline = Date.now() + 2000;
      while (running() && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(running()).toBe(false);
    } finally {
      if (descendant)
        try {
          process.kill(descendant, "SIGKILL");
        } catch {}
      out.mockRestore();
      if (previous === undefined) delete process.env.AGENT_YES_HOME;
      else process.env.AGENT_YES_HOME = previous;
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
