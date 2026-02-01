import { execaCommandSync, parseCommandString } from "execa";
import { logger } from "../logger.ts";
import { catcher } from "../catcher.ts";
import pty, { type IPty } from "../pty.ts";
import type { AgentCliConfig } from "../index.ts";
import type { SUPPORTED_CLIS } from "../SUPPORTED_CLIS.ts";

/**
 * Agent spawning utilities
 */

export interface SpawnOptions {
  cli: SUPPORTED_CLIS;
  cliConf: AgentCliConfig;
  cliArgs: string[];
  verbose: boolean;
  install: boolean;
  ptyOptions: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  };
}

/**
 * Get install command based on platform and configuration
 *
 * Selects the appropriate install command from the configuration
 * based on the current platform (Windows/Unix) and available shells.
 * Falls back to npm if platform-specific commands aren't available.
 *
 * @param installConfig - Install command configuration (string or platform-specific object)
 * @returns Install command string or null if no suitable command found
 *
 * @example
 * ```typescript
 * // Simple string config
 * getInstallCommand('npm install -g claude-cli')
 *
 * // Platform-specific config
 * getInstallCommand({
 *   windows: 'npm install -g claude-cli',
 *   unix: 'curl -fsSL install.sh | sh',
 *   npm: 'npm install -g claude-cli'
 * })
 * ```
 */
function getInstallCommand(
  installConfig:
    | string
    | { powershell?: string; bash?: string; npm?: string; unix?: string; windows?: string },
): string | null {
  if (typeof installConfig === "string") {
    return installConfig;
  }

  const isWindows = process.platform === "win32";
  const platform = isWindows ? "windows" : "unix";

  // Try platform-specific commands first
  if (installConfig[platform]) {
    return installConfig[platform];
  }

  // Try shell-specific commands
  if (isWindows && installConfig.powershell) {
    return installConfig.powershell;
  }

  if (!isWindows && installConfig.bash) {
    return installConfig.bash;
  }

  // Fallback to npm if available
  if (installConfig.npm) {
    return installConfig.npm;
  }

  return null;
}

/**
 * Check if error is a command not found error
 */
function isCommandNotFoundError(e: unknown): boolean {
  if (e instanceof Error) {
    return (
      e.message.includes("command not found") || // unix
      e.message.includes("ENOENT") || // unix
      e.message.includes("spawn") // windows
    );
  }
  return false;
}

/**
 * Spawn agent CLI process with error handling and auto-install
 *
 * Creates a new PTY process for the specified CLI with comprehensive error
 * handling. If the CLI is not found and auto-install is enabled, attempts
 * to install it automatically. Includes special handling for bun-pty issues.
 *
 * @param options - Spawn configuration options
 * @returns IPty process instance
 * @throws Error if CLI not found and installation fails or is disabled
 *
 * @example
 * ```typescript
 * const shell = spawnAgent({
 *   cli: 'claude',
 *   cliConf: config.clis.claude,
 *   cliArgs: ['--verbose'],
 *   verbose: true,
 *   install: false,
 *   ptyOptions: {
 *     name: 'xterm-color',
 *     cols: 80,
 *     rows: 30,
 *     cwd: '/path/to/project',
 *     env: process.env
 *   }
 * });
 * ```
 */
export function spawnAgent(options: SpawnOptions): IPty {
  const { cli, cliConf, cliArgs, verbose, install, ptyOptions } = options;

  const spawn = () => {
    const cliCommand = cliConf?.binary || cli;
    let [bin, ...args] = [...parseCommandString(cliCommand), ...cliArgs];
    logger.debug(`Spawning ${bin} with args: ${JSON.stringify(args)}`);
    const spawned = pty.spawn(bin!, args, ptyOptions);
    logger.info(`[${cli}-yes] Spawned ${bin} with PID ${spawned.pid}`);
    return spawned;
  };

  return catcher(
    // error handler
    (error: unknown, _fn, ..._args) => {
      logger.error(`Fatal: Failed to start ${cli}.`);

      const isNotFound = isCommandNotFoundError(error);
      if (cliConf?.install && isNotFound) {
        const installCmd = getInstallCommand(cliConf.install);
        if (!installCmd) {
          logger.error(`No suitable install command found for ${cli} on this platform`);
          throw error;
        }

        logger.info(`Please install the cli by run ${installCmd}`);

        if (install) {
          logger.info(`Attempting to install ${cli}...`);
          execaCommandSync(installCmd, { stdio: "inherit" });
          logger.info(`${cli} installed successfully. Please rerun the command.`);
          return spawn();
        } else {
          logger.error(`If you did not installed it yet, Please install it first: ${installCmd}`);
          throw error;
        }
      }

      if (globalThis.Bun && error instanceof Error && error.stack?.includes("bun-pty")) {
        // try to fix bun-pty issues
        logger.error(`Detected bun-pty issue, attempted to fix it. Please try again.`);
        require("../pty-fix");
        // unable to retry with same process, so exit here.
      }
      throw error;
    },
    spawn,
  )();
}

