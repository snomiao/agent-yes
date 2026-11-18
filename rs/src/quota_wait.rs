//! Quota wait: ride out an account quota cap instead of leaving the agent
//! parked on it.
//!
//! agy (Antigravity CLI) ends a turn with a banner when the account's quota is
//! spent:
//!
//! ```text
//! ⚠ Individual quota reached. Please upgrade your subscription to increase your
//! limits. Resets in 4m56s.
//! Error ID: 0000aaaa-1111-2222-3333-444455556666-1234
//! ```
//!
//! and then sits at its prompt. Nothing retries the request, so whatever was
//! asked is lost until someone notices. The tracker here turns that into a
//! wait:
//!
//! 1. A banner with an Error ID not seen before starts (or extends) the wait.
//! 2. `/usage` is typed once per wait; its "… Limit Remaining" panel says which
//!    limit ran out and when it refreshes, which can be much later than the
//!    banner's "Resets in" (a spent weekly limit).
//! 3. The interrupted input is resent on an exponential ladder — 1, 2, 4, 8 …
//!    minutes, each step capped at the expected reset — until a resend draws no
//!    new banner for `SETTLE_SECS`.
//! 4. The wait is published to the pid record (`ay ls` shows `quota-wait` and
//!    the expected recovery time) and the agent that handed out the task is
//!    told once, via `ay send`, when to expect it back.
//!
//! Everything here is pure — time comes in as arguments — so the ladder and the
//! screen parsing are unit-tested without a PTY. `context.rs` performs the
//! actions the tracker asks for.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use regex::Regex;

/// First rung of the resend ladder; doubles per failed resend.
pub const BACKOFF_BASE_SECS: u64 = 60;
/// Floor of a rung once the expected reset has passed (or is imminent), so a
/// reset that turns out late is polled at a sane rate rather than hammered.
pub const MIN_WAIT_SECS: u64 = 30;
/// Reset assumed when the banner carries no "Resets in".
pub const DEFAULT_RESET_SECS: u64 = 300;
/// A resend that draws no new banner for this long has gone through.
pub const SETTLE_SECS: u64 = 30;
/// Give up on reading the `/usage` panel after this long.
pub const USAGE_TIMEOUT_SECS: u64 = 20;
/// Gap between typing `/usage` and pressing Enter, so the slash-command menu
/// has rendered and the Enter picks the command rather than racing it.
pub const USAGE_ENTER_DELAY_MS: u64 = 500;
/// Input submitted this long before the first banner counts as the one the
/// banner interrupted. Older input already ran — the cap hit mid-task — so a
/// plain "continue" is resent instead of replaying a finished request.
pub const INTERRUPT_WINDOW_SECS: u64 = 600;
/// A limit with less than this much left (percent) counts as spent.
const SPENT_PCT: f64 = 0.5;

/// Typed when there is no interrupted input to replay. Deliberately avoids the
/// banner's wording so it can never re-match the banner pattern.
pub const CONTINUE_LINE: &str =
    "continue [agent-yes: the usage cap has reset - carry on with the task that was interrupted]";

fn banner_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // Anchored at the warning glyph on its own line, so prose that merely
    // quotes the banner (a message about it, a transcript) does not match.
    RE.get_or_init(|| Regex::new(r"(?m)^[ \t]*⚠[ \t]*Individual quota reached").unwrap())
}

fn resets_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"Resets in ((?:\d+\s*[dhms]\s*)+)").unwrap())
}

fn error_id_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"Error ID:\s*([0-9A-Za-z-]+)").unwrap())
}

fn reply_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"reply: ay send ([0-9A-Za-z_.:-]+)").unwrap())
}

/// Parse a compact duration: "4m56s", "64h39m28s", "143h 9m", "2d 3h", "15s".
pub fn parse_duration(s: &str) -> Option<u64> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(\d+)\s*([dhms])").unwrap());
    let mut total: u64 = 0;
    let mut any = false;
    for c in re.captures_iter(s) {
        let n: u64 = c[1].parse().ok()?;
        let unit = match &c[2] {
            "d" => 86_400,
            "h" => 3_600,
            "m" => 60,
            _ => 1,
        };
        total = total.saturating_add(n.saturating_mul(unit));
        any = true;
    }
    any.then_some(total)
}

/// The quota banner as it stands on screen.
#[derive(Debug, Clone, PartialEq)]
pub struct QuotaBanner {
    pub reset_secs: Option<u64>,
    pub error_id: Option<String>,
    /// Tells one failure from the next: agy mints a fresh Error ID per failed
    /// request, while a banner that is merely still visible keeps its own.
    pub signature: String,
}

/// The LAST quota banner on screen, if any (older ones scroll up above it).
pub fn parse_banner(screen: &str) -> Option<QuotaBanner> {
    let m = banner_re().find_iter(screen).last()?;
    // The banner's own lines: reset and Error ID follow within a few rows.
    let tail: String = screen[m.start()..].chars().take(600).collect();
    // Only the first "Resets in"/"Error ID" after the glyph belong to it.
    let reset_secs = resets_re()
        .captures(&tail)
        .and_then(|c| parse_duration(&c[1]));
    let error_id = error_id_re().captures(&tail).map(|c| c[1].to_string());
    let signature = match &error_id {
        Some(id) => id.clone(),
        None => tail.lines().take(4).collect::<Vec<_>>().join("\n"),
    };
    Some(QuotaBanner {
        reset_secs,
        error_id,
        signature,
    })
}

/// One limit from agy's `/usage` panel.
#[derive(Debug, Clone, PartialEq)]
pub struct UsageLimit {
    /// "Weekly", "Five Hour", …
    pub name: String,
    pub remaining_pct: f64,
    pub refresh_secs: Option<u64>,
}

/// Parse the `/usage` panel ("Models & Quota"):
///
/// ```text
///   Weekly Limit Remaining
///     [█████████░░░░] 49.82%
///     Refreshes in 143h 9m
///   Five Hour Limit Remaining
///     [█████████████] 99.08%
/// ```
pub fn parse_usage(screen: &str) -> Vec<UsageLimit> {
    static HEAD: OnceLock<Regex> = OnceLock::new();
    static PCT: OnceLock<Regex> = OnceLock::new();
    static REFRESH: OnceLock<Regex> = OnceLock::new();
    let head = HEAD.get_or_init(|| Regex::new(r"^\s*(.+?)\s+Limit Remaining\s*$").unwrap());
    let pct = PCT.get_or_init(|| Regex::new(r"(\d+(?:\.\d+)?)\s*%").unwrap());
    let refresh = REFRESH.get_or_init(|| Regex::new(r"Refreshes in\s+(.+)").unwrap());

    let mut out: Vec<UsageLimit> = Vec::new();
    let mut cur: Option<(String, Option<f64>, Option<u64>)> = None;
    let flush = |cur: &mut Option<(String, Option<f64>, Option<u64>)>,
                 out: &mut Vec<UsageLimit>| {
        if let Some((name, Some(p), r)) = cur.take() {
            out.push(UsageLimit {
                name,
                remaining_pct: p,
                refresh_secs: r,
            });
        }
    };
    for line in screen.lines() {
        if let Some(c) = head.captures(line) {
            flush(&mut cur, &mut out);
            cur = Some((c[1].trim().to_string(), None, None));
            continue;
        }
        let Some((_, p, r)) = cur.as_mut() else {
            continue;
        };
        if p.is_none() {
            if let Some(c) = pct.captures(line) {
                *p = c[1].parse().ok();
                continue;
            }
        }
        if r.is_none() {
            if let Some(c) = refresh.captures(line) {
                *r = parse_duration(&c[1]);
            }
        }
    }
    flush(&mut cur, &mut out);
    out
}

/// Longest refresh countdown among the spent limits in this panel.
fn spent_refresh_secs(limits: &[UsageLimit]) -> Option<u64> {
    limits
        .iter()
        .filter(|l| l.remaining_pct < SPENT_PCT)
        .filter_map(|l| l.refresh_secs)
        .max()
}

/// Wait before resend number `attempt` (0-based): 1, 2, 4, 8 … minutes, capped
/// at the time left until the expected reset (floored at `MIN_WAIT_SECS`).
pub fn backoff_secs(attempt: u32, secs_to_reset: u64) -> u64 {
    let ladder = BACKOFF_BASE_SECS.saturating_mul(1u64 << attempt.min(20));
    ladder.min(secs_to_reset.max(MIN_WAIT_SECS))
}

/// The agent to report back to: the last `reply: ay send <id>` in `text` (the
/// envelope `ay send` wraps every message in).
pub fn reply_target(text: &str) -> Option<String> {
    reply_re()
        .captures_iter(text)
        .last()
        .map(|c| c[1].to_string())
}

/// "HH:MM" in local time for a unix-ms instant.
pub fn local_hhmm(unix_ms: i64) -> String {
    use chrono::TimeZone;
    chrono::Local
        .timestamp_millis_opt(unix_ms)
        .single()
        .map(|t| t.format("%H:%M").to_string())
        .unwrap_or_else(|| "?".to_string())
}

/// The one-line heads-up sent to the agent that handed out the task. The
/// leading clause is the wording the operator asked for; it stays inert
/// against the banner pattern (no warning glyph, different words).
pub fn notice_line(hhmm: &str, limits: &[UsageLimit]) -> String {
    let mut s = format!(
        "配额撞顶，预计 {hhmm} 恢复 (agent-yes: the usage cap was hit; it resends the \
         interrupted input with backoff and expects to be back around {hhmm}"
    );
    if !limits.is_empty() {
        let parts: Vec<String> = limits
            .iter()
            .map(|l| format!("{} {}% left", l.name.to_lowercase(), l.remaining_pct))
            .collect();
        s.push_str("; ");
        s.push_str(&parts.join(", "));
    }
    s.push(')');
    s
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum UsagePhase {
    /// `/usage` not typed yet.
    Pending,
    /// `/usage` typed at this instant; Enter follows.
    Typed(Instant),
    /// Enter pressed at this instant; waiting for the panel.
    Entered(Instant),
    /// Panel read; Esc still owed to close it.
    Close,
    Done,
}

#[derive(Debug, Clone)]
pub struct QuotaWait {
    pub started_at: Instant,
    /// Expected reset, as unix ms (published) and as an Instant (scheduling).
    pub reset_unix_ms: i64,
    pub reset_at: Instant,
    // A panel countdown is relative to the time we read it, even after another banner.
    usage_reset: Option<(Instant, i64)>,
    /// Failed resends so far (0 until the first resend fails).
    pub attempt: u32,
    pub next_at: Instant,
    pub next_unix_ms: i64,
    pub usage: UsagePhase,
    pub limits: Vec<UsageLimit>,
    /// Set when a resend (or any submitted input) went out and no new banner
    /// has answered it yet.
    pub probe_at: Option<Instant>,
    pub notified: bool,
    /// Bytes resent on every rung, fixed when the wait starts.
    pub resend: Vec<u8>,
}

/// What the tracker wants done on this tick.
#[derive(Debug, Clone, PartialEq)]
pub enum QuotaAction {
    None,
    /// Type "/usage" (no Enter yet).
    TypeUsage,
    /// Press Enter on the typed "/usage".
    EnterUsage,
    /// Press Esc to close the usage panel.
    CloseUsage,
    /// Tell the task's sender when to expect the agent back.
    Notify(String),
    /// Write these bytes (the interrupted input, ending in its Enter).
    Resend(Vec<u8>),
    /// The quota is back: clear the published wait.
    Recovered,
}

/// What a screen update changed.
#[derive(Debug, Clone, PartialEq)]
pub enum ScreenEvent {
    None,
    /// A wait began.
    Started,
    /// A resend drew a new banner: next rung scheduled.
    Failed,
    /// `/usage` was read and the expected reset recomputed.
    UsageRead,
}

#[derive(Debug, Default)]
pub struct QuotaTracker {
    last_signature: Option<String>,
    pub wait: Option<QuotaWait>,
    /// Last non-empty submitted line, with its Enter, and when it went out.
    last_input: Option<(Vec<u8>, Instant)>,
    /// Bytes typed since the last Enter.
    line: Vec<u8>,
    /// Where the heads-up goes; the latest envelope's reply address wins.
    pub reply_to: Option<String>,
}

fn add_secs_ms(now_ms: i64, secs: u64) -> i64 {
    now_ms.saturating_add((secs as i64).saturating_mul(1000))
}

impl QuotaTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// The launch prompt counts as submitted input at spawn time — a banner
    /// right after start interrupted it.
    pub fn set_initial_prompt(&mut self, prompt: &str, at: Instant) {
        if let Some(to) = reply_target(prompt) {
            self.reply_to = Some(to);
        }
        if !prompt.trim().is_empty() {
            let mut bytes = prompt.as_bytes().to_vec();
            bytes.push(b'\r');
            self.last_input = Some((bytes, at));
        }
    }

    /// Bytes forwarded to the CLI from the user's terminal or the FIFO. Tracks
    /// the last submitted line (resent after a wait) and the reply address;
    /// while waiting, a submission is itself a probe of the quota.
    pub fn on_input(&mut self, data: &[u8], now: Instant) {
        const MAX_LINE: usize = 256 * 1024;
        for &b in data {
            if b == b'\r' {
                let line = std::mem::take(&mut self.line);
                let text = String::from_utf8_lossy(&line);
                // A bare Enter (an `ay submit`, a re-pressed Enter) is not a new
                // request — keep the line it was pressing on.
                if !text.trim().is_empty() {
                    if let Some(to) = reply_target(&text) {
                        self.reply_to = Some(to);
                    }
                    let mut bytes = line;
                    bytes.push(b'\r');
                    self.last_input = Some((bytes, now));
                }
                if let Some(w) = self.wait.as_mut() {
                    w.probe_at = Some(now);
                }
            } else if self.line.len() < MAX_LINE {
                self.line.push(b);
            }
        }
    }

    /// Screen changed. `now_ms` is wall-clock unix ms for publishing.
    pub fn on_screen(&mut self, screen: &str, now: Instant, now_ms: i64) -> ScreenEvent {
        // The usage panel, once asked for.
        if let Some(w) = self.wait.as_mut() {
            if matches!(w.usage, UsagePhase::Entered(_)) {
                let limits = parse_usage(screen);
                if !limits.is_empty() {
                    w.limits = limits;
                    w.usage = UsagePhase::Close;
                    w.usage_reset = spent_refresh_secs(&w.limits)
                        .map(|secs| (now + Duration::from_secs(secs), add_secs_ms(now_ms, secs)));
                    if let Some(reset) = w.usage_reset {
                        if reset.0 > w.reset_at {
                            (w.reset_at, w.reset_unix_ms) = reset;
                        }
                    }
                    let left = w.reset_at.saturating_duration_since(now).as_secs();
                    let wait = backoff_secs(w.attempt, left);
                    let next = (w.started_at + Duration::from_secs(wait)).max(now);
                    w.next_unix_ms =
                        add_secs_ms(now_ms, next.saturating_duration_since(now).as_secs());
                    w.next_at = next;
                    return ScreenEvent::UsageRead;
                }
            }
        }

        let Some(banner) = parse_banner(screen) else {
            return ScreenEvent::None;
        };
        if self.last_signature.as_deref() == Some(banner.signature.as_str()) {
            return ScreenEvent::None;
        }
        self.last_signature = Some(banner.signature.clone());

        match self.wait.as_mut() {
            None => {
                let reset = banner.reset_secs.unwrap_or(DEFAULT_RESET_SECS);
                let wait = backoff_secs(0, reset);
                let resend = match &self.last_input {
                    Some((bytes, at))
                        if now.saturating_duration_since(*at).as_secs()
                            <= INTERRUPT_WINDOW_SECS =>
                    {
                        bytes.clone()
                    }
                    _ => {
                        let mut b = CONTINUE_LINE.as_bytes().to_vec();
                        b.push(b'\r');
                        b
                    }
                };
                self.wait = Some(QuotaWait {
                    started_at: now,
                    reset_unix_ms: add_secs_ms(now_ms, reset),
                    reset_at: now + Duration::from_secs(reset),
                    usage_reset: None,
                    attempt: 0,
                    next_at: now + Duration::from_secs(wait),
                    next_unix_ms: add_secs_ms(now_ms, wait),
                    usage: UsagePhase::Pending,
                    limits: Vec::new(),
                    probe_at: None,
                    notified: false,
                    resend,
                });
                ScreenEvent::Started
            }
            Some(w) => {
                w.attempt = w.attempt.saturating_add(1);
                let secs = banner.reset_secs.unwrap_or(DEFAULT_RESET_SECS);
                let banner_reset = (now + Duration::from_secs(secs), add_secs_ms(now_ms, secs));
                (w.reset_at, w.reset_unix_ms) = w
                    .usage_reset
                    .map_or(banner_reset, |reset| reset.max(banner_reset));
                let wait = backoff_secs(
                    w.attempt,
                    w.reset_at.saturating_duration_since(now).as_secs(),
                );
                w.next_at = now + Duration::from_secs(wait);
                w.next_unix_ms = add_secs_ms(now_ms, wait);
                w.probe_at = None;
                ScreenEvent::Failed
            }
        }
    }

    /// One heartbeat. `at_prompt` = the CLI is idle at its prompt and the
    /// terminal has been quiet a moment (safe to type into).
    pub fn on_tick(&mut self, now: Instant, at_prompt: bool) -> QuotaAction {
        let Some(w) = self.wait.as_mut() else {
            return QuotaAction::None;
        };
        match w.usage {
            UsagePhase::Pending => {
                if at_prompt {
                    w.usage = UsagePhase::Typed(now);
                    return QuotaAction::TypeUsage;
                }
                return QuotaAction::None;
            }
            UsagePhase::Typed(t) => {
                if at_prompt
                    && now.saturating_duration_since(t).as_millis()
                        >= u128::from(USAGE_ENTER_DELAY_MS)
                {
                    w.usage = UsagePhase::Entered(now);
                    return QuotaAction::EnterUsage;
                }
                return QuotaAction::None;
            }
            UsagePhase::Entered(t) => {
                if now.saturating_duration_since(t).as_secs() < USAGE_TIMEOUT_SECS {
                    return QuotaAction::None;
                }
                // No panel: carry on with the banner's reset alone.
                w.usage = UsagePhase::Done;
            }
            UsagePhase::Close => {
                w.usage = UsagePhase::Done;
                return QuotaAction::CloseUsage;
            }
            UsagePhase::Done => {}
        }
        if !w.notified {
            w.notified = true;
            return QuotaAction::Notify(notice_line(&local_hhmm(w.reset_unix_ms), &w.limits));
        }
        if let Some(p) = w.probe_at {
            if now.saturating_duration_since(p).as_secs() >= SETTLE_SECS {
                self.wait = None;
                return QuotaAction::Recovered;
            }
            return QuotaAction::None;
        }
        if now >= w.next_at && at_prompt {
            w.probe_at = Some(now);
            return QuotaAction::Resend(w.resend.clone());
        }
        QuotaAction::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BANNER: &str = "  some earlier output\n\n\
⚠ Individual quota reached. Please upgrade your subscription to increase your\n\n\
limits. Resets in 4m56s.\n\n\
Error ID: 0000aaaa-1111-2222-3333-444455556666-1234\n\n\
>  \n";

    fn banner_with(id: &str, reset: &str) -> String {
        format!(
            "⚠ Individual quota reached. Please upgrade your subscription to increase your\n\
             limits. Resets in {reset}.\nError ID: {id}\n> \n"
        )
    }

    const USAGE: &str = "└ Models & Quota\n\n  Account: alice@example.com\n\nGEMINI MODELS\n\n\
  Models within this group: Model A, Model B\n\n\
  Weekly Limit Remaining\n\n\
    [█████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░] 49.82%\n\n\
    Refreshes in 143h 9m\n\n\n\
  Five Hour Limit Remaining\n\n\
    [██████████████████████████████████████████████████] 99.08%\n\n\n\
  (1–11 of 37 lines)\n\
Scroll · pgup/pgdown Page · ctrl+end Bottom · ctrl+home Top · esc Close\n";

    #[test]
    fn durations_parse_in_every_shape_agy_prints() {
        assert_eq!(parse_duration("4m56s"), Some(296));
        assert_eq!(parse_duration("64h39m28s"), Some(64 * 3600 + 39 * 60 + 28));
        assert_eq!(parse_duration("143h 9m"), Some(143 * 3600 + 9 * 60));
        assert_eq!(parse_duration("15s."), Some(15));
        assert_eq!(parse_duration("2d 3h"), Some(2 * 86_400 + 3 * 3600));
        assert_eq!(parse_duration("soon"), None);
    }

    #[test]
    fn banner_yields_reset_and_error_id() {
        let b = parse_banner(BANNER).unwrap();
        assert_eq!(b.reset_secs, Some(296));
        assert_eq!(
            b.error_id.as_deref(),
            Some("0000aaaa-1111-2222-3333-444455556666-1234")
        );
        assert_eq!(b.signature, "0000aaaa-1111-2222-3333-444455556666-1234");
    }

    #[test]
    fn the_last_banner_on_screen_wins() {
        let screen = format!(
            "{}\n{}",
            banner_with("id-1", "10m"),
            banner_with("id-2", "64h1m")
        );
        let b = parse_banner(&screen).unwrap();
        assert_eq!(b.error_id.as_deref(), Some("id-2"));
        assert_eq!(b.reset_secs, Some(64 * 3600 + 60));
    }

    #[test]
    fn prose_quoting_the_banner_is_not_a_banner() {
        assert!(parse_banner("alice: the screen says Individual quota reached, look\n").is_none());
        assert!(parse_banner("> Individual quota reached. Please upgrade\n").is_none());
        assert!(parse_banner("all good\n> ").is_none());
    }

    #[test]
    fn a_banner_without_id_still_has_a_stable_signature() {
        let s = "⚠ Individual quota reached. Please upgrade\nlimits. Resets in 1m.\n";
        let a = parse_banner(s).unwrap();
        let b = parse_banner(s).unwrap();
        assert_eq!(a.error_id, None);
        assert_eq!(a.signature, b.signature);
        assert_eq!(a.reset_secs, Some(60));
    }

    #[test]
    fn usage_panel_parses_each_limit() {
        let limits = parse_usage(USAGE);
        assert_eq!(
            limits,
            vec![
                UsageLimit {
                    name: "Weekly".into(),
                    remaining_pct: 49.82,
                    refresh_secs: Some(143 * 3600 + 9 * 60),
                },
                UsageLimit {
                    name: "Five Hour".into(),
                    remaining_pct: 99.08,
                    refresh_secs: None,
                },
            ]
        );
        assert!(parse_usage("nothing here\n> ").is_empty());
    }

    #[test]
    fn a_spent_limit_pushes_the_reset_out() {
        let spent = vec![
            UsageLimit {
                name: "Weekly".into(),
                remaining_pct: 40.0,
                refresh_secs: Some(100 * 3600),
            },
            UsageLimit {
                name: "Five Hour".into(),
                remaining_pct: 0.0,
                refresh_secs: Some(2 * 3600),
            },
        ];
        assert_eq!(spent_refresh_secs(&spent), Some(2 * 3600));
        assert_eq!(spent_refresh_secs(&spent[..1]), None);
        assert_eq!(spent_refresh_secs(&[]), None);
    }

    #[test]
    fn backoff_doubles_by_the_minute_and_caps_at_the_reset() {
        let far = 10 * 3600;
        assert_eq!(backoff_secs(0, far), 60);
        assert_eq!(backoff_secs(1, far), 120);
        assert_eq!(backoff_secs(2, far), 240);
        assert_eq!(backoff_secs(3, far), 480);
        assert_eq!(backoff_secs(10, far), far); // 1024 min > 10 h: capped
        assert_eq!(backoff_secs(2, 150), 150); // the reset comes first
        assert_eq!(backoff_secs(0, 0), MIN_WAIT_SECS); // past the reset: floor
        assert_eq!(backoff_secs(u32::MAX, u64::MAX), 60 << 20); // no overflow
    }

    #[test]
    fn reply_target_takes_the_latest_envelope() {
        let text = "<ay-msg 1a2b3c4d from claude alice@box:/repo/alpha#1111 — reply: ay send 0123abcd4567 \"...\">\nhi";
        assert_eq!(reply_target(text).as_deref(), Some("0123abcd4567"));
        let two = format!("{text}\n<ay-msg 5e6f7a8b from x — reply: ay send 2222 \"...\">");
        assert_eq!(reply_target(&two).as_deref(), Some("2222"));
        assert_eq!(reply_target("no envelope"), None);
    }

    #[test]
    fn notice_names_the_time_and_stays_off_the_banner_pattern() {
        let line = notice_line("15:20", &parse_usage(USAGE));
        assert!(line.starts_with("配额撞顶，预计 15:20 恢复"));
        assert!(line.contains("weekly 49.82% left"));
        assert!(parse_banner(&line).is_none());
        assert!(parse_banner(CONTINUE_LINE).is_none());
    }

    fn run_usage(t: &mut QuotaTracker, now: Instant, ms: i64, screen: &str) -> Instant {
        assert_eq!(t.on_tick(now, true), QuotaAction::TypeUsage);
        let now = now + Duration::from_millis(USAGE_ENTER_DELAY_MS);
        assert_eq!(t.on_tick(now, true), QuotaAction::EnterUsage);
        assert_eq!(
            t.on_screen(screen, now, ms + USAGE_ENTER_DELAY_MS as i64),
            ScreenEvent::UsageRead
        );
        assert_eq!(t.on_tick(now, true), QuotaAction::CloseUsage);
        now
    }

    #[test]
    fn full_wait_resends_the_interrupted_input_until_it_goes_through() {
        let t0 = Instant::now();
        let ms0: i64 = 1_800_000_000_000;
        let mut t = QuotaTracker::new();
        t.on_input(b"<ay-msg 1a2b3c4d from x \xe2\x80\x94 reply: ay send 0123abcd \"...\">\nfix it\n</ay-msg 1a2b3c4d>", t0);
        t.on_input(b"\r", t0);
        assert_eq!(t.reply_to.as_deref(), Some("0123abcd"));

        // Banner: the wait starts with a one-minute first rung.
        let s1 = banner_with("id-1", "4m56s");
        assert_eq!(t.on_screen(&s1, t0, ms0), ScreenEvent::Started);
        // Still on screen next frame: same failure, nothing new.
        assert_eq!(t.on_screen(&s1, t0, ms0), ScreenEvent::None);
        let w = t.wait.as_ref().unwrap();
        assert_eq!(w.reset_unix_ms, ms0 + 296_000);
        assert!(w.resend.ends_with(b"</ay-msg 1a2b3c4d>\r"));

        let now = run_usage(&mut t, t0, ms0, USAGE);
        match t.on_tick(now, true) {
            QuotaAction::Notify(line) => assert!(line.contains("恢复")),
            other => panic!("expected Notify, got {other:?}"),
        }
        // Not before the first rung.
        assert_eq!(
            t.on_tick(t0 + Duration::from_secs(59), true),
            QuotaAction::None
        );
        // Not while the CLI is busy.
        assert_eq!(
            t.on_tick(t0 + Duration::from_secs(60), false),
            QuotaAction::None
        );
        let at = t0 + Duration::from_secs(60);
        let QuotaAction::Resend(bytes) = t.on_tick(at, true) else {
            panic!("expected Resend");
        };
        assert!(bytes.ends_with(b"</ay-msg 1a2b3c4d>\r"));

        // That resend failed too: next rung is two minutes, capped at the reset.
        let s2 = banner_with("id-2", "3m50s");
        assert_eq!(t.on_screen(&s2, at, ms0 + 60_000), ScreenEvent::Failed);
        let w = t.wait.as_ref().unwrap();
        assert_eq!(w.attempt, 1);
        assert_eq!(w.next_at, at + Duration::from_secs(120));
        assert_eq!(w.reset_unix_ms, ms0 + 60_000 + 230_000);

        let at2 = at + Duration::from_secs(120);
        assert!(matches!(t.on_tick(at2, true), QuotaAction::Resend(_)));
        // No new banner for SETTLE_SECS: it went through.
        assert_eq!(
            t.on_tick(at2 + Duration::from_secs(SETTLE_SECS - 1), true),
            QuotaAction::None
        );
        assert_eq!(
            t.on_tick(at2 + Duration::from_secs(SETTLE_SECS), true),
            QuotaAction::Recovered
        );
        assert!(t.wait.is_none());
    }

    #[test]
    fn a_spent_weekly_limit_reschedules_past_the_banner_reset() {
        let t0 = Instant::now();
        let ms0: i64 = 1_800_000_000_000;
        let mut t = QuotaTracker::new();
        t.on_input(b"do the thing\r", t0);
        t.on_screen(&banner_with("id-1", "4m56s"), t0, ms0);
        let spent = USAGE.replace("49.82%", "0.00%");
        run_usage(&mut t, t0, ms0, &spent);
        let w = t.wait.as_ref().unwrap();
        assert_eq!(
            w.reset_unix_ms,
            ms0 + USAGE_ENTER_DELAY_MS as i64 + (143 * 3600 + 9 * 60) * 1000
        );
        // The first rung is still one minute: the cap only bounds the ladder.
        assert_eq!(w.next_at, t0 + Duration::from_secs(60));
    }

    #[test]
    fn enter_rechecks_the_prompt_after_typing_usage() {
        let now = Instant::now();
        let mut tracker = QuotaTracker::new();
        tracker.on_screen(&banner_with("first", "1m"), now, 0);
        assert_eq!(tracker.on_tick(now, true), QuotaAction::TypeUsage);
        let later = now + Duration::from_millis(USAGE_ENTER_DELAY_MS);
        assert_eq!(tracker.on_tick(later, false), QuotaAction::None);
        assert_eq!(tracker.on_tick(later, true), QuotaAction::EnterUsage);
    }

    #[test]
    fn a_fresh_banner_preserves_the_absolute_spent_limit_deadline() {
        let start = Instant::now();
        let mut tracker = QuotaTracker::new();
        tracker.on_screen(&banner_with("first", "1m"), start, 0);
        let observed = run_usage(
            &mut tracker,
            start,
            0,
            "Weekly Limit Remaining\n0.00%\nRefreshes in 2h\n",
        );
        tracker.on_screen(
            &banner_with("second", "1m"),
            start + Duration::from_secs(60),
            60_000,
        );
        let wait = tracker.wait.as_ref().unwrap();
        assert_eq!(wait.reset_at, observed + Duration::from_secs(7200));
        assert_eq!(wait.reset_unix_ms, USAGE_ENTER_DELAY_MS as i64 + 7_200_000);
    }

    #[test]
    fn stale_input_is_not_replayed() {
        let t0 = Instant::now();
        let mut t = QuotaTracker::new();
        t.on_input(b"long finished request\r", t0);
        let later = t0 + Duration::from_secs(INTERRUPT_WINDOW_SECS + 1);
        t.on_screen(&banner_with("id-1", "1m"), later, 0);
        let w = t.wait.as_ref().unwrap();
        assert_eq!(w.resend, [CONTINUE_LINE.as_bytes(), b"\r"].concat());
    }

    #[test]
    fn the_launch_prompt_counts_as_input() {
        let t0 = Instant::now();
        let mut t = QuotaTracker::new();
        t.set_initial_prompt("build it — reply: ay send 9999abcd \"...\"", t0);
        assert_eq!(t.reply_to.as_deref(), Some("9999abcd"));
        t.on_screen(&banner_with("id-1", "1m"), t0, 0);
        assert!(t.wait.as_ref().unwrap().resend.starts_with(b"build it"));
    }

    #[test]
    fn a_bare_enter_keeps_the_last_line_but_probes_the_quota() {
        let t0 = Instant::now();
        let mut t = QuotaTracker::new();
        t.on_input(b"real request\r", t0);
        t.on_screen(&banner_with("id-1", "10m"), t0, 0);
        // Usage panel never shows up: the wait carries on after the timeout.
        assert_eq!(t.on_tick(t0, true), QuotaAction::TypeUsage);
        let t1 = t0 + Duration::from_millis(USAGE_ENTER_DELAY_MS);
        assert_eq!(t.on_tick(t1, true), QuotaAction::EnterUsage);
        let t2 = t1 + Duration::from_secs(USAGE_TIMEOUT_SECS);
        assert!(matches!(t.on_tick(t2, true), QuotaAction::Notify(_)));
        // Someone presses Enter by hand: that is a probe, and it went through.
        t.on_input(b"\r", t2);
        assert_eq!(t.last_input.as_ref().unwrap().0, b"real request\r");
        assert_eq!(
            t.on_tick(t2 + Duration::from_secs(SETTLE_SECS), true),
            QuotaAction::Recovered
        );
    }
}
