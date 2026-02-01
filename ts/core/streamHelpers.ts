import type { TerminalTextRender } from "terminal-render";
import { logger } from "../logger.ts";
import type { SUPPORTED_CLIS } from "../SUPPORTED_CLIS.ts";
import type { IPty } from "../pty.ts";

/**
 * Stream processing utilities for terminal I/O
 *
 * Provides helper functions for handling terminal control codes,
 * signal processing, and stream lifecycle management.
 */

/**
 * Handle console control codes (cursor position, device attributes)
 *
 * Processes ANSI escape sequences from the terminal output and responds
 * appropriately. Handles Device Attributes (DA) queries and cursor position
 * requests when stdin is not a TTY.
 *
 * @param text - Raw terminal output text containing potential control codes
 * @param shell - PTY shell instance for sending responses
 * @param terminalRender - Terminal renderer for cursor position tracking
 * @param cli - CLI name for special handling (e.g., codex)
 * @param verbose - Whether to log verbose debug messages
 *
 * @example
 * ```typescript
 * stream.forEach((text) => {
 *   handleConsoleControlCodes(text, shell, terminalRender, 'claude', true);
 * });
 * ```
 */
export function handleConsoleControlCodes(
  text: string,
  shell: IPty,
  terminalRender: TerminalTextRender,
  cli: SUPPORTED_CLIS,
  verbose: boolean,
) {
  // Render terminal output for log file
  terminalRender.write(text);

  // Handle Device Attributes query (DA) - ESC[c or ESC[0c
  // This must be handled regardless of TTY status
  if (text.includes("\u001b[c") || text.includes("\u001b[0c")) {
    // Respond shell with VT100 with Advanced Video Option
    shell.write("\u001b[?1;2c");
    if (verbose) {
      logger.debug("device|respond DA: VT100 with Advanced Video Option");
    }
    return;
  }

  // Only handle cursor position when stdin is not tty, because tty already handled this
  if (process.stdin.isTTY) return;

  // Handle cursor position request - ESC[6n
  if (!text.includes("\u001b[6n")) return;

  // xterm replies CSI row; column R if asked cursor position
  // https://en.wikipedia.org/wiki/ANSI_escape_code#:~:text=citation%20needed%5D-,xterm%20replies,-CSI%20row%C2%A0%3B
  const { col, row } = terminalRender.getCursorPosition();
  shell.write(`\u001b[${row};${col}R`); // reply cli when getting cursor position
  logger.debug(`cursor|respond position: row=${String(row)}, col=${String(col)}`);
}

/**
 * Create a transformer that handles terminate signals (CTRL+C, CTRL+Z)
 *
 * Returns a function that processes input chunks and handles keyboard
 * interrupt signals. CTRL+C (SIGINT) is only processed when stdin is
 * not ready (agent is loading), allowing graceful shutdown. CTRL+Z is
 * currently filtered out as suspend/resume is not yet supported.
 *
 * @param stdinReady - ReadyManager indicating if stdin is ready
 * @param onAbort - Callback invoked when user aborts with SIGINT
 * @returns Transformer function that processes chunks and handles signals
 *
 * @example
 * ```typescript
 * const handler = createTerminateSignalHandler(ctx.stdinReady, (exitCode) => {
 *   shell.kill('SIGINT');
 *   process.exit(exitCode);
 * });
 * stream.map(handler);
 * ```
 */
export function createTerminateSignalHandler(
  stdinReady: { isReady: boolean },
  onAbort: (exitCode: number) => void,
) {
  let aborted = false;

  return (chunk: string): string => {
    // handle CTRL+Z and filter it out (not supported yet)
    if (!aborted && chunk === "\u001A") {
      return "";
    }

    // handle CTRL+C when stdin is not ready (agent is loading)
    if (!aborted && !stdinReady.isReady && chunk === "\u0003") {
      logger.error("User aborted: SIGINT");
      onAbort(130); // SIGINT exit code
      aborted = true;
      return chunk; // still pass to agent, but they'll probably be killed
    }

    return chunk; // normal inputs
  };
}

/**
 * Create a terminator transform stream that ends when promise resolves
 *
 * Creates a TransformStream that automatically terminates when the provided
 * promise resolves. Used to stop output processing when the agent exits.
 *
 * @param exitPromise - Promise that resolves when stream should terminate
 * @returns TransformStream that terminates on promise resolution
 *
 * @example
 * ```typescript
 * const exitPromise = Promise.withResolvers<number>();
 * stream.by(createTerminatorStream(exitPromise.promise));
 *
 * // Later, when agent exits:
 * exitPromise.resolve(0);
 * ```
 */
export function createTerminatorStream(exitPromise: Promise<unknown>): TransformStream<string, string> {
  return new TransformStream({
    start: function terminator(ctrl) {
      exitPromise.then(() => ctrl.terminate());
    },
    transform: (e, ctrl) => ctrl.enqueue(e),
    flush: (ctrl) => ctrl.terminate(),
  });
}
