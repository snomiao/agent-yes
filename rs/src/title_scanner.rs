//! Incremental scanner for terminal-title escapes in the child CLI's PTY
//! stream.
//!
//! Coding-agent CLIs (claude, opencode, codex) continuously set the terminal
//! title to a summary of what they are doing via `OSC 0`/`OSC 2`
//! (`ESC ] 0 ; <title> BEL`, also terminated by `ESC \`). The wrapper sits on
//! the PTY anyway, so scanning the stream gives a live "what is this agent
//! doing" label for free — surfaced as `title` in the pid registry and shown
//! by `ay whoami` / `ay ls --json`.
//!
//! The scanner is a tiny state machine fed arbitrary chunk boundaries: a title
//! sequence split across two reads must still parse, and everything that is
//! not a title sequence must pass through untouched (the scanner never
//! modifies the stream — it only observes).

/// Titles longer than this are junk (a runaway OSC without a terminator);
/// discard the sequence instead of buffering unboundedly.
const MAX_TITLE_LEN: usize = 512;
/// What we store/display: enough for a task summary, short enough for a table.
const STORED_TITLE_LEN: usize = 256;

#[derive(Default)]
enum State {
    #[default]
    Ground,
    Esc,         // saw ESC
    OscParam,    // saw ESC ] — collecting the numeric param
    OscTitle,    // param was 0/2 and ';' consumed — collecting title chars
    OscOther,    // some other OSC — skip to terminator
    OscTitleEsc, // inside title, saw ESC (maybe ST `ESC \`)
    OscOtherEsc, // inside other OSC, saw ESC
}

#[derive(Default)]
pub struct TitleScanner {
    state: State,
    param: String,
    title: String,
}

impl TitleScanner {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one output chunk; returns the LAST complete title in it, if any.
    pub fn feed(&mut self, chunk: &str) -> Option<String> {
        let mut found: Option<String> = None;
        for c in chunk.chars() {
            match self.state {
                State::Ground => {
                    if c == '\x1b' {
                        self.state = State::Esc;
                    }
                }
                State::Esc => {
                    if c == ']' {
                        self.param.clear();
                        self.state = State::OscParam;
                    } else if c == '\x1b' {
                        // stay: ESC ESC ] … still starts an OSC
                    } else {
                        self.state = State::Ground;
                    }
                }
                State::OscParam => match c {
                    '0'..='9' if self.param.len() < 4 => self.param.push(c),
                    ';' => {
                        // OSC 0 (icon+title) and OSC 2 (title) carry the window
                        // title; OSC 1 is icon-only and everything else (8, 52,
                        // 133, …) is unrelated.
                        if self.param == "0" || self.param == "2" {
                            self.title.clear();
                            self.state = State::OscTitle;
                        } else {
                            self.state = State::OscOther;
                        }
                    }
                    '\x07' => self.state = State::Ground,
                    '\x1b' => self.state = State::OscOtherEsc,
                    _ => self.state = State::OscOther,
                },
                State::OscTitle => match c {
                    '\x07' => {
                        found = Some(clean_title(&self.title));
                        self.state = State::Ground;
                    }
                    '\x1b' => self.state = State::OscTitleEsc,
                    _ => {
                        if self.title.len() >= MAX_TITLE_LEN {
                            // Runaway sequence — drop it and resync.
                            self.state = State::OscOther;
                        } else {
                            self.title.push(c);
                        }
                    }
                },
                State::OscTitleEsc => {
                    if c == '\\' {
                        found = Some(clean_title(&self.title));
                    }
                    // Either way the OSC is over (a bare ESC aborts it).
                    self.state = State::Ground;
                }
                State::OscOther => {
                    if c == '\x07' {
                        self.state = State::Ground;
                    } else if c == '\x1b' {
                        self.state = State::OscOtherEsc;
                    }
                }
                State::OscOtherEsc => {
                    self.state = State::Ground;
                }
            }
        }
        found.filter(|t| !t.is_empty())
    }
}

/// Control chars can't be typed into a title bar, and the stored value ends up
/// in JSONL + terminal tables — strip them and clamp.
fn clean_title(raw: &str) -> String {
    let cleaned: String = raw.chars().filter(|c| !c.is_control()).collect();
    let trimmed = cleaned.trim();
    trimmed.chars().take(STORED_TITLE_LEN).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_osc0_bel() {
        let mut s = TitleScanner::new();
        assert_eq!(
            s.feed("\x1b]0;✳ fixing tests\x07"),
            Some("✳ fixing tests".into())
        );
    }

    #[test]
    fn parses_osc2_st() {
        let mut s = TitleScanner::new();
        assert_eq!(s.feed("\x1b]2;my task\x1b\\"), Some("my task".into()));
    }

    #[test]
    fn survives_chunk_split_mid_sequence() {
        let mut s = TitleScanner::new();
        assert_eq!(s.feed("text \x1b]0;ha"), None);
        assert_eq!(s.feed("lf done\x07 more"), Some("half done".into()));
    }

    #[test]
    fn last_title_in_chunk_wins() {
        let mut s = TitleScanner::new();
        assert_eq!(s.feed("\x1b]0;one\x07\x1b]2;two\x07"), Some("two".into()));
    }

    #[test]
    fn ignores_icon_only_and_unrelated_osc() {
        let mut s = TitleScanner::new();
        assert_eq!(
            s.feed("\x1b]1;icon\x07\x1b]52;c;YWJj\x07\x1b]133;A\x07"),
            None
        );
    }

    #[test]
    fn ignores_non_osc_escapes_and_plain_text() {
        let mut s = TitleScanner::new();
        assert_eq!(s.feed("plain \x1b[31mred\x1b[0m text"), None);
    }

    #[test]
    fn caps_runaway_titles() {
        let mut s = TitleScanner::new();
        let junk = "x".repeat(2000);
        assert_eq!(s.feed(&format!("\x1b]0;{junk}\x07")), None);
        // …and resyncs afterwards:
        assert_eq!(s.feed("\x1b]0;ok\x07"), Some("ok".into()));
    }

    #[test]
    fn strips_control_chars_and_empty_titles() {
        let mut s = TitleScanner::new();
        assert_eq!(s.feed("\x1b]0;a\tb\x07"), Some("ab".into()));
        assert_eq!(s.feed("\x1b]0;\x07"), None);
        assert_eq!(s.feed("\x1b]0;   \x07"), None);
    }
}
