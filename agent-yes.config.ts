import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defineCliYesConfig } from "./ts/defineConfig.ts";
import { deepMixin } from "./ts/utils.ts";
import { logger } from "./ts/logger.ts";

logger.debug("loading cli-yes.config.ts from " + import.meta.url);

// For config path,
// 0. default value is defined here, auto imported
// 2. can override by ~/.agent-yes config, try to mkdir logs to that to find out if we have permission to write it
// 3. can override by workspace-local temporary ./node_modules/.agent-yes config directory so it works in sandboxed envs
// 3. can override by workspace-local ./.agent-yes project-specific config

// Helper function to test if we can write to a directory

// Determine config directory with 3-tier fallback
const configDir = await (async () => {
  // 1. If running in dev mode (ts file), use current directory
  // const isDevMode = import.meta.url.endsWith(".ts");
  // if (isDevMode) {
  //   const devConfigDir = path.resolve(process.cwd(), ".agent-yes");
  //   if (process.env.VERBOSE) console.log("[config] Dev mode detected, using:", devConfigDir);
  //   return devConfigDir;
  // }

  // 2. Try ~/.agent-yes as default
  const homeConfigDir = path.resolve(os.homedir(), ".agent-yes");
  const isHomeWritable = await mkdir(homeConfigDir, { recursive: true })
    .then(() => true)
    .catch(() => false);
  if (isHomeWritable) {
    logger.debug("[config] Using home directory:", homeConfigDir);
    return homeConfigDir;
  }

  // 3. Fallback to tmp dir
  const tmpConfigDir = path.resolve("/tmp/.agent-yes");
  const isWritable = await mkdir(tmpConfigDir, { recursive: true });
  if (isWritable) {
    logger.debug("[config] Using workspace directory:", tmpConfigDir);
    return tmpConfigDir;
  }

  return undefined;
})();

// For logs, use configDir/logs

export default deepMixin(
  await getDefaultConfig(),
  await import(path.resolve(os.homedir(), ".agent-yes/config.ts"))
    .catch(() => ({ default: {} }))
    .then((mod) => mod.default),
  await import(path.resolve(process.cwd(), "node_modules/.agent-yes/config.ts"))
    .catch(() => ({ default: {} }))
    .then((mod) => mod.default),
  await import(path.resolve(process.cwd(), ".agent-yes/config.ts"))
    .catch(() => ({ default: {} }))
    .then((mod) => mod.default),
);

function getDefaultConfig() {
  return defineCliYesConfig({
    configDir,
    logsDir: configDir && path.resolve(configDir, "logs"),
    clis: {
      claude: {
        // args
        promptArg: "last-arg",
        systemPrompt: "--append-system-prompt",
        //
        install: {
          // try this first if powershell available and its windows
          powershell: "irm https://claude.ai/install.ps1 | iex", // powershell
          // or bash if found
          bash: "curl -fsSL https://claude.ai/install.sh | bash",
          // fallback to npm if bash not found
          npm: "npm i -g @anthropic-ai/claude-code@latest",
        },
        // regex matcher for stdin ready
        ready: [
          /\? for shortcuts/,
          /\u00A0Try "/, // regex matcher for stdin ready (note: \u00A0 is non-breaking space)
          /^\? for shortcuts/,
          /^>[ \u00A0]/,
          /──────────+/,
        ], // regex matcher for stdin ready
        working: [/esc to interrupt/, /to run in background/],
        typingRespond: {
          "1\n": [/│ Do you want to use this API key\?/],
        },
        enter: [
          / > 1. Yes, I trust this folder/m,
          /❯ 1\. Dark mode ?✔/m,
          /❯ 1\. Yes, continue/m,
          /❯ 1\. Yes/m,
          /^.{0,4} 1\. Dark mode ?✔/m,
          /^.{0,4} 1\. Yes, continue/m,
          /^.{0,4} 1\. Yes/m,
          /Press Enter to continue…/m,
        ],
        fatal: [/⎿  Claude usage limit reached\./, /^error: unknown option/],
        restoreArgs: ["--continue"], // restart with --continue when crashed
        restartWithoutContinueArg: [/No conversation found to continue/],
        exitCommand: ["/exit"],
        bunx: true, // use bunx to run the binary, start time is 5s faster than node
        defaultArgs: ["--model=sonnet"], // default to sonnet, to prevent opus model overload
      },
      gemini: {
        install: "npm install -g @google/gemini-cli@latest",
        // match the agent prompt after initial lines; handled by index logic using line index
        ready: [/Type your message/], // used with line index check
        enter: [/│ ● 1. Yes, allow once/, /│ ● 1. Allow once/, /│ ● 1. Allow once/],
        fatal: [/Error resuming session/, /No previous sessions found for this project./],
        restoreArgs: ["--resume"], // restart with --resume when crashed
        restartWithoutContinueArg: [
          /No previous sessions found for this project\./,
          /Error resuming session/,
        ],
        exitCommand: ["/chat save ${PWD}", "/quit"],
      },
      codex: {
        promptArg: "first-arg",
        install: "npm install -g @openai/codex@latest",
        updateAvailable: [/^✨⬆️ Update available!/],
        ready: [
          /⏎ send/, // legacy
          /\? for shortcuts/, // 2026-01-05 update
        ],
        enter: [
          /> 1. Yes,/,
          /> 1. Yes, allow Codex to work in this folder/,
          /> 1. Approve and run now/,
        ],
        fatal: [/Error: The cursor position could not be read within/],
        // add to codex --search by default when not provided by the user
        defaultArgs: ["--search"],
        noEOL: true, // codex use cursor moving instead of EOL when rendering output
      },
      // below are experimental agents
      qwen: {
        install: "npm install -g @qwen-code/qwen-code@latest",
        version: "qwen --version",
      },
      grok: {
        install: "npm install -g @vibe-kit/grok-cli@latest",
        ready: [/^  │ ❯ +/],
        enter: [/^   1. Yes/],
      },
      copilot: {
        promptArg: "-i", // use stdin to prompt or it will reject all bash commands
        install: "npm install -g @github/copilot",
        ready: [/^ +> /, /Ctrl\+c Exit/],
        enter: [/ │ ❯ +1. Yes, proceed/, / ❯ +1. Yes/],
        system:
          "IMPORTANT: USE TOOLS TO RESEARCH/EXPLORE/WORKAROUND your self, except you need approve on DESTRUCTIVE OPERATIONS, DONT ASK QUESTIONS ON USERS REQUEST, JUST SOLVE IT.", //copilot asks too much
        fatal: [],
      },
      cursor: {
        install: "open https://cursor.com/ja/docs/cli/installation",
        // map logical "cursor" cli name to actual binary name
        binary: "cursor-agent",
        bunx: true,
        ready: [/\/ commands/],
        enter: [/→ Run \(once\) \(y\) \(enter\)/, /▶ \[a\] Trust this workspace/],
        fatal: [/^  Error: You've hit your usage limit/],
      },
      auggie: {
        help: "https://docs.augmentcode.com/cli/overview",
        install: "npm install -g @augmentcode/auggie",
        promptArg: "first-arg",
        ready: [/ > /, /\? to show shortcuts/],
        typingRespond: {
          "y\n": [/\[Y\] Enable indexing - Unlock full workspace understanding/],
        },
        enter: [], // auggie seems not to ask for permission currently, which is super nice
        fatal: [], // no fatal patterns known yet
      },
      amp: {
        help: "https://ampcode.com/",
        install: {
          bash: "curl -fsSL https://ampcode.com/install.sh | bash",
          npm: "npm i -g @sourcegraph/amp",
        },
        enter: [/^.{0,4} Approve /],
      },
      opencode: {
        help: "https://opencode.ai/",
        install: {
          bash: "curl -fsSL https://opencode.ai/install | bash",
          npm: "npm i -g opencode-ai",
        },
        enter: [],
        ready: [],
      },
    },
  });
}
