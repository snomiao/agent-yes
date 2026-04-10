import { Terminal } from "@xterm/headless";
import { logger } from "./logger.ts";

/**
 * XtermProxy wraps @xterm/headless to act as a full xterm terminal emulator
 * between a PTY process and downstream consumers.
 *
 * It automatically responds to ALL terminal queries (DSR, DA, OSC, etc.)
 * by piping xterm's onData responses back to the PTY — so the spawned
 * process never blocks waiting for a terminal reply, even in non-TTY
 * environments or when the real terminal is backgrounded.
 */
export class XtermProxy {
  private term: Terminal;
  private writeToPty: (data: string) => void;
  private readableController: ReadableStreamDefaultController<string> | null = null;

  /** Downstream readable — passthrough of PTY output for sflow pipeline */
  readonly readable: ReadableStream<string>;

  constructor(opts: { cols?: number; rows?: number; writeToPty: (data: string) => void }) {
    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? 24;
    this.writeToPty = opts.writeToPty;

    this.term = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: 10000,
    });

    // xterm internally generates responses to terminal queries (DSR, DA, etc.)
    // and fires them via onData. Pipe those back to the PTY stdin.
    this.term.onData((data) => {
      logger.debug(`xterm-proxy|onData response: ${JSON.stringify(data)}`);
      this.writeToPty(data);
    });

    // Create a ReadableStream for downstream consumption (sflow pipeline)
    this.readable = new ReadableStream<string>({
      start: (controller) => {
        this.readableController = controller;
      },
    });
  }

  /**
   * Feed PTY output into the xterm emulator.
   * - xterm processes escape sequences and updates internal state
   * - Terminal queries (ESC[6n, ESC[c, etc.) trigger onData → writeToPty
   * - Raw data is pushed to readable for downstream consumption
   */
  write(data: string): void {
    // Push to downstream readable first (passthrough)
    this.readableController?.enqueue(data);

    // Feed to xterm for state tracking and query auto-response
    this.term.write(data);
  }

  /** Get cursor position from xterm's buffer state */
  getCursorPosition(): { row: number; col: number } {
    const buf = this.term.buffer.active;
    // xterm uses 0-based; terminal-render used 0-based too
    return { row: buf.cursorY, col: buf.cursorX };
  }

  /**
   * Get the last N lines of rendered terminal content (plain text, no ANSI).
   * Equivalent to terminal-render's tail(n).
   */
  tail(n: number): string {
    const buf = this.term.buffer.active;
    const totalLines = buf.length;
    const startLine = Math.max(0, totalLines - n);
    const lines: string[] = [];
    for (let i = startLine; i < totalLines; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : "");
    }
    // Trim trailing empty lines
    while (lines.length > 1 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return lines.join("\n");
  }

  /**
   * Render the full terminal buffer as plain text.
   * Equivalent to terminal-render's render().
   */
  render(): string {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : "");
    }
    // Trim trailing empty lines
    while (lines.length > 1 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return lines.join("\n");
  }

  /** Resize the virtual terminal */
  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  /** Clean up resources */
  dispose(): void {
    this.readableController?.close();
    this.term.dispose();
  }
}
