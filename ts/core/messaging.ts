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
}

/**
 * Send Enter key to the shell after waiting for idle state
 * @param context Message context with shell and state managers
 * @param waitms Milliseconds to wait for idle before sending Enter (default: 1000)
 */
export async function sendEnter(context: MessageContext, waitms = 1000) {
  // wait for idle for a bit to let agent cli finish rendering
  const st = Date.now();
  await context.idleWaiter.wait(waitms); // wait for idle a while
  const et = Date.now();
  logger.debug(`sendEn| idleWaiter.wait(${String(waitms)}) took ${String(et - st)}ms`);
  context.nextStdout.unready();
  // send the enter key
  context.shell.write("\r");

  // retry once if not received any output in 1 second after sending Enter
  await Promise.race([
    context.nextStdout.wait(),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        if (!context.nextStdout.ready) {
          context.shell.write("\r");
        }
        resolve();
      }, 1000),
    ),
  ]);

  // retry the second time if not received any output in 3 second after sending Enter
  await Promise.race([
    context.nextStdout.wait(),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        if (!context.nextStdout.ready) {
          context.shell.write("\r");
        }
        resolve();
      }, 3000),
    ),
  ]);
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
  await context.nextStdout.wait();
  logger.debug(`sending enter`);
  await sendEnter(context, 1000);
  logger.debug(`sent enter`);
}
