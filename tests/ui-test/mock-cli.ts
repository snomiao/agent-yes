/**
 * Mock CLI for UI tests.
 * Simulates agent-yes wrapping a claude-like CLI and producing
 * rich PTY output (ANSI colors, unicode, progress bars, wrapped lines).
 */

const cols = Number(process.env.COLUMNS ?? 80);

function write(s: string) {
  process.stdout.write(s);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function line(text: string) {
  write(text + "\r\n");
}

function colored(text: string, code: number) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

(async () => {
  // Show a header
  line(colored("╔" + "═".repeat(cols - 2) + "╗", 36));
  line(colored("║  agent-yes UI test — mock claude session", 36));
  line(colored("╚" + "═".repeat(cols - 2) + "╝", 36));
  line("");

  await sleep(100);

  // Show "ready" pattern that agent-yes waits for
  line(colored("✓ Claude Code v1.2.3 (mock)", 32));
  line("");
  line("? for shortcuts");
  line("");

  await sleep(200);

  // Simulate Claude outputting a long response with various widths
  line(colored("▶ User: explain PTY resize", 33));
  line("");

  await sleep(100);

  // Output that tests word-wrap at the terminal width
  const longText =
    "PTY (Pseudo-Terminal) resize propagation is a critical feature that ensures " +
    "the child process inside agent-yes always renders at the correct terminal " +
    "dimensions. When the outer terminal is resized, a SIGWINCH signal is delivered " +
    "to agent-yes, which then calls ioctl(TIOCSWINSZ) on the inner PTY master fd. " +
    "This causes the kernel to update the inner PTY's winsize struct and deliver " +
    "SIGWINCH to the child process group, so the child (claude/codex) redraws.";

  // Print word-wrapped
  const words = longText.split(" ");
  let curLine = "";
  for (const word of words) {
    if ((curLine + word).length >= cols - 2) {
      line(colored(curLine.trimEnd(), 37));
      curLine = word + " ";
    } else {
      curLine += word + " ";
    }
    await sleep(10);
  }
  if (curLine.trim()) line(colored(curLine.trimEnd(), 37));
  line("");

  await sleep(200);

  // Show a progress bar
  line(colored("Analyzing...", 35));
  for (let i = 0; i <= 20; i++) {
    const filled = Math.round((i / 20) * (cols - 20));
    const bar = "[" + "█".repeat(filled) + "░".repeat(cols - 20 - filled) + "]";
    write(`\r${colored(bar, 34)} ${String(i * 5).padStart(3)}%`);
    await sleep(50);
  }
  write("\r\n");
  line("");

  // Show a table that tests column alignment
  line(colored("┌──────────────────┬──────────┬──────────┐", 36));
  line(colored("│ Signal           │ Platform │ Status   │", 36));
  line(colored("├──────────────────┼──────────┼──────────┤", 36));
  line(colored("│ SIGWINCH         │ Linux    │ ✓ works  │", 36));
  line(colored("│ SIGWINCH         │ macOS    │ ✓ works  │", 36));
  line(colored("│ PTY resize       │ Windows  │ ✗ n/a    │", 36));
  line(colored("└──────────────────┴──────────┴──────────┘", 36));
  line("");

  await sleep(200);

  // Final ready state
  line(colored("✓ Session complete. Press Ctrl+C to exit.", 32));
  line("");

  // Keep alive for a while so playwright can screenshot
  await sleep(30000);
})();
