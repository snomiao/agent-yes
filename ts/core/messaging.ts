import { IdleWaiter } from "../idleWaiter.ts";
import { ReadyManager } from "../ReadyManager.ts";
import { logger } from "../logger.ts";

/**
 * Message sending utilities for agent CLI interaction
 */

export interface MessageContext {
  shell: { write: (data: string) => void };
  idleWaiter: IdleWaiter;
  stdinReady: ReadyManager;
  nextStdout: ReadyManager;
  /** Rendered screen. When set, sendEnter judges "responded" by a screen change, not by bytes. */
  screen?: () => string;
}

/**
 * Send Enter key to the shell after waiting for idle state
 * @param context Message context with shell and state managers
 * @param waitms Milliseconds to wait for idle before sending Enter (default: 1000)
 */
export async function sendEnter(context: MessageContext, waitms = 1000) {
  const st = Date.now();
  await context.idleWaiter.wait(waitms);
  logger.debug(`sendEnter| idleWait took ${String(Date.now() - st)}ms`);
  context.nextStdout.unready();
  context.shell.write("\r");
  context.idleWaiter.ping(); // mirrors sendMessage — a programmatic Enter is activity too

  // The CLI responded only if the rendered screen changed: claude's title spinner
  // (OSC 0) streams bytes while a dialog that swallowed the Enter sits unanswered.
  // Without a (non-empty) screen, fall back to "any stdout".
  const screenAtEnter = context.screen?.() || undefined;
  const responded = () =>
    screenAtEnter === undefined ? context.nextStdout.isReady : context.screen?.() !== screenAtEnter;

  // Retry Enter if the CLI hasn't responded within escalating timeouts
  for (const ms of [1000, 3000]) {
    const deadline = Date.now() + ms;
    while (!responded() && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, Math.min(100, deadline - Date.now())));
    if (responded()) return;
    context.shell.write("\r");
    context.idleWaiter.ping();
  }
}

/**
 * Send a message to the shell
 * @param context Message context with shell and state managers
 * @param message Message string to send
 * @param options Options for message sending
 */
export async function sendMessage(
  context: MessageContext,
  message: string,
  { waitForReady = true } = {},
) {
  if (waitForReady) await context.stdinReady.wait();
  // show in-place message: write msg and move cursor back start
  logger.debug(`send  |${message}`);
  context.nextStdout.unready();
  context.shell.write(message);
  context.idleWaiter.ping(); // just sent a message, wait for echo
  logger.debug(`waiting next stdout|${message}`);
  await Promise.race([
    context.nextStdout.wait(),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        logger.warn(`nextStdout.wait() timed out after 30s for message: ${message}`);
        resolve();
      }, 30000),
    ),
  ]);
  logger.debug(`sending enter`);
  await sendEnter(context, 1000);
  logger.debug(`sent enter`);
}
