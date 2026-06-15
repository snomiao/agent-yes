import { existsSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { getWorkspaceRoot, setWorkspaceRoot } from "./workspaceConfig.ts";

// `ay setup` — guided onboarding. Two steps:
//   1. choose the workspace root (the default cwd new agents spawn into when the
//      console doesn't pass one — see workspaceConfig), and
//   2. share this machine to the agent-yes.com console over WebRTC, installed as a
//      restart-on-boot daemon (delegates to `ay serve install --share`).
//
// Designed to degrade gracefully: with a TTY it prompts (defaulting to the
// current/home workspace); piped or in a script it takes the first positional as
// the workspace and otherwise keeps the current one — never blocking on input.
export async function cmdSetup(rest: string[]): Promise<number> {
  if (rest.includes("-h") || rest.includes("--help")) {
    process.stdout.write(
      `Usage: ay setup [workspace-dir] [--no-share] [--port N]\n\n` +
        `Guided setup:\n` +
        `  1. pick the workspace root new agents spawn into (default: your home dir)\n` +
        `  2. share this machine to the agent-yes.com console (a restart-on-boot daemon)\n\n` +
        `Options:\n` +
        `  workspace-dir   default directory for new agents (skips the prompt)\n` +
        `  --no-share      set the workspace only; don't install the share daemon\n` +
        `  --port N        HTTP API port for the share daemon (default: 7432)\n`,
    );
    return 0;
  }

  const noShare = rest.includes("--no-share");
  const portIdx = rest.indexOf("--port");
  const port = portIdx >= 0 ? rest[portIdx + 1] : undefined;
  // The workspace is the first non-flag token (and not the value of --port).
  const positional = rest.filter((a, i) => !a.startsWith("-") && i !== portIdx + 1);

  // 1. Workspace root.
  let ws = positional[0];
  if (!ws) {
    const current = getWorkspaceRoot();
    if (stdin.isTTY && stdout.isTTY) {
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        const ans = (await rl.question(`Workspace root for new agents [${current}]: `)).trim();
        ws = ans || current;
      } finally {
        rl.close();
      }
    } else {
      ws = current; // non-interactive: keep whatever's configured (home by default)
    }
  }
  const abs = setWorkspaceRoot(ws);
  process.stdout.write(`workspace root: ${abs}\n`);
  if (!existsSync(abs)) {
    process.stderr.write(
      `  note: that directory doesn't exist yet — create it, or agents spawned there will fail\n`,
    );
  }

  if (noShare) return 0;

  // 2. Share to agent-yes.com as a boot-persistent daemon. `ay serve install`
  //    handles oxmgr registration, version roll-forward, and printing the link.
  process.stdout.write(`\nsharing this machine to agent-yes.com…\n`);
  const { cmdServe } = await import("./serve.ts");
  return cmdServe(["install", "--share", ...(port ? ["--port", port] : [])]);
}
