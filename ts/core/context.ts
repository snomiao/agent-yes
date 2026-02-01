import { ReadyManager } from "../ReadyManager.ts";
import { IdleWaiter } from "../idleWaiter.ts";
import type { PidStore } from "../pidStore.ts";
import type { AgentCliConfig } from "../index.ts";
import type { SUPPORTED_CLIS } from "../SUPPORTED_CLIS.ts";
import type { LogPaths } from "./logging.ts";
import type { IPty } from "../pty.ts";

/**
 * Shared context for agent session
 *
 * Groups related state and dependencies for easier passing between modules.
 * This class encapsulates all stateful components needed during an agent session,
 * including the PTY shell, configuration, state managers, and flags.
 *
 * @example
 * ```typescript
 * const ctx = new AgentContext({
 *   shell,
 *   pidStore,
 *   logPaths,
 *   cli: 'claude',
 *   cliConf,
 *   verbose: true,
 *   robust: true
 * });
 *
 * // Access message context for sending messages
 * await sendMessage(ctx.messageContext, 'Hello');
 *
 * // Check and update state
 * if (ctx.isFatal) {
 *   await exitAgent();
 * }
 * ```
 */
export class AgentContext {
  // Core state
  shell: IPty;
  pidStore: PidStore;
  logPaths: LogPaths;

  // Configuration
  cli: SUPPORTED_CLIS;
  cliConf: AgentCliConfig;
  verbose: boolean;
  robust: boolean;

  // State managers
  stdinReady = new ReadyManager();
  stdinFirstReady = new ReadyManager();
  nextStdout = new ReadyManager();
  idleWaiter = new IdleWaiter();

  // Flags
  isFatal = false;
  shouldRestartWithoutContinue = false;

  constructor(params: {
    shell: IPty;
    pidStore: PidStore;
    logPaths: LogPaths;
    cli: SUPPORTED_CLIS;
    cliConf: AgentCliConfig;
    verbose: boolean;
    robust: boolean;
  }) {
    this.shell = params.shell;
    this.pidStore = params.pidStore;
    this.logPaths = params.logPaths;
    this.cli = params.cli;
    this.cliConf = params.cliConf;
    this.verbose = params.verbose;
    this.robust = params.robust;
  }

  /**
   * Get message context for sendMessage/sendEnter helpers
   *
   * Provides a lightweight object with only the dependencies needed
   * for message sending operations, avoiding circular references.
   *
   * @returns MessageContext object for use with sendMessage/sendEnter
   */
  get messageContext() {
    return {
      shell: this.shell,
      idleWaiter: this.idleWaiter,
      stdinReady: this.stdinReady,
      nextStdout: this.nextStdout,
    };
  }
}
