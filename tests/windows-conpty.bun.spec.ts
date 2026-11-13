import { test, expect } from "bun:test";
import { spawn } from "bun-pty";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const binary = process.env.AGENT_YES_TEST_BINARY ?? join(homedir(), ".cargo/bin/agent-yes.exe");
const recorder = resolve(import.meta.dir, "fixtures/windows-console-recorder.ts");
// Actual Windows key/mouse records, not a regex that merely hides the symptom.
const cases = {
  arrows: "\x1b[A\x1b[B\x1b[C\x1b[D\x1bOA\x1bOB\x1bOC\x1bOD",
  navigation: "\x1b[H\x1b[F\x1b[2~\x1b[3~\x1b[5~\x1b[6~",
  functionKeys:
    "\x1bOP\x1bOQ\x1bOR\x1bOS\x1b[15~\x1b[17~\x1b[18~\x1b[19~\x1b[20~\x1b[21~\x1b[23~\x1b[24~",
  modifiers: "\x1b[Z\x1b[1;2A\x1b[1;5D\x1b[1;3C",
  editing: "\t\r\x7f\x08",
  text: "text日本語😀",
  paste: "\x1b[200~paste\r\n日本語\x1b[201~",
  focus: "\x1b[I\x1b[O",
  mouse: "\x1b[<0;5;8M\x1b[<32;6;8M\x1b[<0;6;8m\x1b[<35;5;8M\x1b[<64;5;8M\x1b[<65;5;8M",
};

for (const runtime of ["Rust", "TypeScript"])
  test.skipIf(process.platform !== "win32" || !existsSync(binary))(
    `${runtime} wrapper preserves all input protocols through nested ConPTY`,
    async () => {
      const tempRoot = resolve(tmpdir());
      const dir = mkdtempSync(join(tempRoot, "ay-conpty-"));
      writeFileSync(
        join(dir, ".agent-yes.config.json"),
        JSON.stringify({
          clis: {
            bash: {
              binary: process.execPath,
              defaultArgs: [recorder],
              ready: ["PROBE_READY"],
              enter: [],
              noEOL: true,
              promptArg: "last-arg",
            },
          },
        }),
      );
      const run = async (nested: boolean) => {
        const log = join(dir, `${nested}.jsonl`);
        writeFileSync(log, "");
        const wrapperExe = runtime === "Rust" ? binary : process.execPath;
        const wrapperArgs =
          runtime === "Rust"
            ? ["--cli=bash", "--auto=no", "--robust=false", "--force-tty"]
            : [
                resolve(import.meta.dir, "../dist/cli.js"),
                "--cli=bash",
                "--no-rust",
                "--auto=no",
                "--no-robust",
              ];
        const modeLog = join(dir, `mode-${runtime}.json`);
        const p = spawn(
          process.execPath,
          nested
            ? [
                resolve(import.meta.dir, "fixtures/windows-wrapper-host.ts"),
                wrapperExe,
                ...wrapperArgs,
              ]
            : [recorder],
          {
            cwd: dir,
            cols: 100,
            rows: 24,
            env: {
              ...process.env,
              PROBE_LOG: log,
              MODE_LOG: modeLog,
              AGENT_YES_HOME: join(dir, "home"),
              AGENT_YES_NO_UPDATE: "1",
              AGENT_YES_TRAY: "0",
              CY_FORCE_TTY: "1",
            },
          },
        );
        let output = "";
        let exited = false;
        p.onData((s) => {
          output += s;
          if (s.includes("\x1b[6n")) p.write("\x1b[1;1R");
        });
        p.onExit(() => {
          exited = true;
        });
        const wait = async (fn: () => boolean) => {
          const deadline = Date.now() + 15000;
          while (!fn()) {
            if (Date.now() > deadline) throw new Error(`PTY timed out: ${JSON.stringify(output)}`);
            await Bun.sleep(20);
          }
        };
        try {
          await wait(() => output.includes("PROBE_READY"));
          p.write(Object.values(cases).join(""));
          // Ctrl+C is a wrapper shortcut: exercise it as its own keypress.
          await Bun.sleep(50);
          p.write("\x03");
          await Bun.sleep(50);
          p.write("\ue000");
          await wait(() => exited);
          if (nested) {
            const mode = JSON.parse(readFileSync(modeLog, "utf8"));
            expect(mode.after).toBe(mode.before);
          }
          return readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((s) => JSON.parse(s));
        } catch (error) {
          console.error(error);
          console.error(readFileSync(log, "utf8").slice(-1500));
          throw error;
        } finally {
          if (!exited) {
            await Bun.spawn(["taskkill.exe", "/PID", String(p.pid), "/T", "/F"], {
              stdout: "ignore",
              stderr: "ignore",
            }).exited;
            p.kill();
          }
        }
      };
      try {
        const direct = await run(false),
          nested = await run(true);
        expect(
          direct.filter((e) => e.type === 1 && e.down && [37, 38, 39, 40].includes(e.vk)).length,
        ).toBeGreaterThanOrEqual(8);
        expect(nested).toEqual(direct);
      } finally {
        try {
          if (dirname(dir) !== tempRoot || !basename(dir).startsWith("ay-conpty-")) {
            throw new Error("Unexpected test cleanup path");
          }
          rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        } catch {
          /* Windows may retain the PTY cwd briefly. */
        }
      }
    },
    40000,
  );
