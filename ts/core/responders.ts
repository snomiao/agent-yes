import sflow from "sflow";
import { logger } from "../logger.ts";
import { sendEnter, sendMessage } from "./messaging.ts";
import type { AgentContext } from "./context.ts";
import type { AgentCliConfig } from "../index.ts";
import type { SUPPORTED_CLIS } from "../SUPPORTED_CLIS.ts";
import { extractSessionId, storeSessionForCwd } from "../resume/codexSessionManager.ts";

/**
 * Auto-response handlers for CLI-specific patterns
 *
 * Provides intelligent auto-response logic that monitors CLI output and
 * triggers appropriate actions based on configured patterns. Handles ready
 * signals, fatal errors, enter key automation, and session management.
 */

export interface AutoResponderOptions {
  ctx: AgentContext;
  conf: AgentCliConfig;
  cli: SUPPORTED_CLIS;
  workingDir: string;
  exitAgent: () => Promise<void>;
}

/**
 * Create auto-response handler that processes CLI output lines
 * and triggers appropriate responses based on configured patterns
 *
 * Analyzes each line of CLI output and triggers configured responses:
 * - Ready signals: Mark stdin as ready when agent is ready for input
 * - Enter automation: Send Enter key when specific prompts are detected
 * - Typing responses: Send configured text in response to patterns
 * - Fatal errors: Trigger agent exit on fatal error patterns
 * - Session management: Capture and store session IDs for resumption
 *
 * @param line - Output line to analyze
 * @param lineIndex - Line number in the stream (0-indexed)
 * @param options - Configuration and context for response handling
 *
 * @example
 * ```typescript
 * stream
 *   .lines()
 *   .forEach(async (line, i) =>
 *     createAutoResponseHandler(line, i, {
 *       ctx,
 *       conf: cliConfig,
 *       cli: 'claude',
 *       workingDir: '/path/to/project',
 *       exitAgent: async () => { ... }
 *     })
 *   );
 * ```
 */
export async function createAutoResponseHandler(
  line: string,
  lineIndex: number,
  options: AutoResponderOptions,
) {
  const { ctx, conf, cli, workingDir, exitAgent } = options;

  logger.debug(`stdout|${line}`);

  // ready matcher: if matched, mark stdin ready
  if (conf.ready?.some((rx: RegExp) => line.match(rx))) {
    logger.debug(`ready |${line}`);
    if (cli === "gemini" && lineIndex <= 80) return; // gemini initial noise, only after many lines
    ctx.stdinReady.ready();
    ctx.stdinFirstReady.ready();
  }

  // enter matchers: send Enter when any enter regex matches
  if (conf.enter?.some((rx: RegExp) => line.match(rx))) {
    logger.debug(`sendEnter matched|${line}`);
    return await sendEnter(ctx.messageContext, 400); // wait for idle for a short while and then send Enter
  }

  // typingRespond matcher: if matched, send the specified message
  const typingResponded = await sflow(Object.entries(conf.typingRespond ?? {}))
    .filter(([_sendString, onThePatterns]) => onThePatterns.some((rx) => line.match(rx)))
    .map(
      async ([sendString]) =>
        await sendMessage(ctx.messageContext, sendString, { waitForReady: false }),
    )
    .toCount();
  if (typingResponded) return;

  // fatal matchers: set isFatal flag when matched
  if (conf.fatal?.some((rx: RegExp) => line.match(rx))) {
    logger.debug(`fatal |${line}`);
    ctx.isFatal = true;
    await exitAgent();
  }

  // restartWithoutContinueArg matchers: set flag to restart without continue args
  if (conf.restartWithoutContinueArg?.some((rx: RegExp) => line.match(rx))) {
    logger.debug(`restart-without-continue|${line}`);
    ctx.shouldRestartWithoutContinue = true;
    ctx.isFatal = true; // also set fatal to trigger exit
    await exitAgent();
  }

  // session ID capture for codex
  if (cli === "codex") {
    const sessionId = extractSessionId(line);
    if (sessionId) {
      logger.debug(`session|captured session ID: ${sessionId}`);
      await storeSessionForCwd(workingDir, sessionId);
    }
  }
}
