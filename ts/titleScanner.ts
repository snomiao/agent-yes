/**
 * Incremental scanner for terminal-title escapes (OSC 0/2) in the child CLI's
 * PTY stream — the TS-runtime mirror of rs/src/title_scanner.rs; keep the two
 * in sync.
 *
 * Coding-agent CLIs (claude, opencode, codex) continuously set the terminal
 * title to a summary of what they are doing (`ESC ] 0 ; <title> BEL`, also
 * terminated by `ESC \`). The wrapper observes the stream anyway, so scanning
 * it yields a live "what is this agent doing" label for free — surfaced as
 * `title` in the pid registry and shown by `ay whoami` / `ay ls --json`.
 *
 * Fed arbitrary chunk boundaries: a sequence split across reads still parses.
 * The scanner only observes — it never modifies the stream.
 */

/** A title longer than this is a runaway OSC without terminator — discard. */
const MAX_TITLE_LEN = 512;
/** What we store/display. */
const STORED_TITLE_LEN = 256;

const enum State {
  Ground,
  Esc,
  OscParam,
  OscTitle,
  OscOther,
  OscTitleEsc,
  OscOtherEsc,
}

export class TitleScanner {
  private state = State.Ground;
  private param = "";
  private title = "";

  /** Feed one output chunk; returns the LAST complete title in it, if any. */
  feed(chunk: string): string | null {
    let found: string | null = null;
    for (const c of chunk) {
      switch (this.state) {
        case State.Ground:
          if (c === "\x1b") this.state = State.Esc;
          break;
        case State.Esc:
          if (c === "]") {
            this.param = "";
            this.state = State.OscParam;
          } else if (c !== "\x1b") {
            this.state = State.Ground;
          }
          break;
        case State.OscParam:
          if (c >= "0" && c <= "9" && this.param.length < 4) {
            this.param += c;
          } else if (c === ";") {
            // OSC 0 (icon+title) and 2 (title) carry the window title; OSC 1
            // is icon-only and everything else (8, 52, 133, …) is unrelated.
            if (this.param === "0" || this.param === "2") {
              this.title = "";
              this.state = State.OscTitle;
            } else {
              this.state = State.OscOther;
            }
          } else if (c === "\x07") {
            this.state = State.Ground;
          } else if (c === "\x1b") {
            this.state = State.OscOtherEsc;
          } else {
            this.state = State.OscOther;
          }
          break;
        case State.OscTitle:
          if (c === "\x07") {
            found = cleanTitle(this.title);
            this.state = State.Ground;
          } else if (c === "\x1b") {
            this.state = State.OscTitleEsc;
          } else if (this.title.length >= MAX_TITLE_LEN) {
            this.state = State.OscOther; // runaway — drop and resync
          } else {
            this.title += c;
          }
          break;
        case State.OscTitleEsc:
          if (c === "\\") found = cleanTitle(this.title);
          this.state = State.Ground; // a bare ESC aborts the OSC either way
          break;
        case State.OscOther:
          if (c === "\x07") this.state = State.Ground;
          else if (c === "\x1b") this.state = State.OscOtherEsc;
          break;
        case State.OscOtherEsc:
          this.state = State.Ground;
          break;
      }
    }
    return found || null;
  }
}

/** Strip control chars (they can't be typed into a title bar) and clamp. */
function cleanTitle(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const trimmed = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return trimmed.slice(0, STORED_TITLE_LEN);
}

/**
 * Change-gated + rate-limited publisher: registry writes take the
 * cross-runtime lock, while claude retitles every few seconds — the steady
 * state must cost zero writes, and a retitle burst collapses to one write per
 * window. Call `poll()` from any recurring point in the run loop so the final
 * title still lands within a window after the CLI goes quiet.
 */
export class TitlePublisher {
  private latest: string | null = null;
  private written: string | null = null;
  private writtenAt = 0;

  constructor(
    private readonly write: (title: string) => void,
    private readonly minIntervalMs = 2_000,
  ) {}

  observe(title: string): void {
    this.latest = title;
    this.poll();
  }

  poll(now: number = Date.now()): void {
    if (this.latest === null || this.latest === this.written) return;
    if (now - this.writtenAt < this.minIntervalMs) return;
    this.write(this.latest);
    this.written = this.latest;
    this.writtenAt = now;
  }
}
