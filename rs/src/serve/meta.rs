// Screen-derived agent metadata for `/api/ls`: task counts, status badges, the
// pending needs_input question, and a git snapshot. Ports of ts/todoParse.ts,
// ts/badges.ts, ts/needsInput.ts and serve.ts's gitStatus so the Rust and TS
// daemons produce identical records for the same agent.
//
// Every parser here is pure (takes rendered lines) — the log read + vt100
// render happens in api.rs, which also owns the (size, mtime) caches.

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;

// ── todo block (ts/todoParse.ts) ─────────────────────────────────────────────

const ANCHOR: char = '⎿';

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TaskCounts {
    pub done: u32,
    pub total: u32,
}

#[derive(PartialEq, Clone, Copy)]
enum Marker {
    Done,
    InProgress,
    Pending,
}

/// Classify a rendered line by its first glyph, after stripping indent and an
/// optional leading `⎿`.
fn marker_of(line: &str) -> Option<Marker> {
    let s = line.trim_start();
    let s = match s.strip_prefix(ANCHOR) {
        Some(rest) => rest.trim_start(),
        None => s,
    };
    match s.chars().next()? {
        '✔' | '☑' | '✓' | '☒' => Some(Marker::Done),
        '◼' => Some(Marker::InProgress),
        '◻' | '☐' => Some(Marker::Pending),
        _ => None,
    }
}

/// Most recent confidently-detected todo block: a maximal run of consecutive
/// marker lines, anchored by `⎿` on the run's first line or the one above it,
/// with >= 2 markers. Conservative by design — a stray check glyph in prose
/// must never produce a phantom badge.
pub fn parse_task_counts(lines: &[String]) -> Option<TaskCounts> {
    let mut best = None;
    let n = lines.len();
    let mut i = 0;
    while i < n {
        if marker_of(&lines[i]).is_none() {
            i += 1;
            continue;
        }
        let mut has_anchor = i > 0 && lines[i - 1].contains(ANCHOR);
        let (mut done, mut total) = (0u32, 0u32);
        let mut j = i;
        while j < n {
            let Some(mk) = marker_of(&lines[j]) else { break };
            if lines[j].contains(ANCHOR) {
                has_anchor = true;
            }
            if mk == Marker::Done {
                done += 1;
            }
            total += 1;
            j += 1;
        }
        if has_anchor && total >= 2 {
            best = Some(TaskCounts { done, total });
        }
        i = if j == i { i + 1 } else { j };
    }
    best
}

// ── badges (ts/badges.ts) ────────────────────────────────────────────────────

struct BadgeDef {
    id: &'static str,
    pattern: Regex,
}

/// Mirrors BADGE_DEFS in ts/badges.ts — same ids, same anchors. A pattern with
/// a capture group makes the badge dynamic: the wire id becomes `id:capture`
/// ("shells:4 shells") and the console re-derives the label from it.
static BADGE_DEFS: Lazy<Vec<BadgeDef>> = Lazy::new(|| {
    let d = |id, pat: &str| BadgeDef { id, pattern: Regex::new(pat).unwrap() };
    vec![
        d("goal-active", r"(?i)/goal active"),
        d("session-limit", r"(?i)you['’]?ve hit your session limit"),
        // Anchored on the FULL banner so an agent merely discussing retries
        // can't light it; `[\s\S]{0,40}` spans the "· " separator / a wrap.
        d("retrying", r"(?is)Waiting for API response.{0,40}will retry in \d"),
        // Footer counters: anchored on the "· " separator / "←" arrow chrome,
        // never the bare phrase. The capture keeps the CLI's own pluralisation.
        d("shells", r"(?m)· (\d+ shells?)(?: ·|\s*$)"),
        d("monitors", r"(?m)· (\d+ monitors?)(?: ·|\s*$)"),
        d("bg-agents", r"(?m)← (\d+ agents?)(?: ·|\s*$)"),
        d("pr", r"(?m)· (PR #\d+)(?: ·|\s*$)"),
    ]
});

/// The id appended by the ls code when the Rust runner's stdin-activity marker
/// is fresh. Never screen-matched — see TYPING_BADGE in ts/badges.ts.
pub const TYPING_BADGE: &str = "typing";

pub fn match_badges(lines: &[String]) -> Vec<String> {
    let text = lines.join("\n");
    BADGE_DEFS
        .iter()
        .filter_map(|d| {
            let caps = d.pattern.captures(&text)?;
            Some(match caps.get(1) {
                Some(m) => format!("{}:{}", d.id, m.as_str()),
                None => d.id.to_string(),
            })
        })
        .collect()
}

// ── needs_input (ts/needsInput.ts) ───────────────────────────────────────────

/// The `(needsInput, working)` patterns a CLI ships with, cascading user
/// overrides on top — the same pair `ay ls` classifies against, so the Rust
/// daemon's `needs_input` dot can't drift from the CLI's.
pub fn cli_patterns(cli: &str) -> Option<(Vec<Regex>, Vec<Regex>)> {
    use crate::config_loader::{compile_regex_list, load_cascading_config, ConfigFile};
    static BUILTIN: Lazy<ConfigFile> = Lazy::new(|| {
        serde_yaml::from_str(include_str!("../../default.config.yaml")).unwrap_or_default()
    });
    let mut cfg = BUILTIN.clone();
    cfg.merge(load_cascading_config());
    let raw = cfg.clis.get(cli)?;
    Some((
        compile_regex_list(raw.needs_input.clone()).ok()?,
        compile_regex_list(raw.working.clone()).ok()?,
    ))
}

static RE_HR: Lazy<Regex> = Lazy::new(|| Regex::new(r"^─+$").unwrap());
static RE_ESC: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^esc to (interrupt|cancel)").unwrap());
static RE_SHORTCUTS: Lazy<Regex> = Lazy::new(|| Regex::new(r"\? for shortcuts").unwrap());
static RE_COMPACT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\d+%\s*until auto-compact").unwrap());

fn is_chrome_line(s: &str) -> bool {
    let t = s.trim();
    t.is_empty()
        || RE_HR.is_match(t)
        || RE_ESC.is_match(t)
        || RE_SHORTCUTS.is_match(t)
        || RE_COMPACT.is_match(t)
}

/// Returns the pending question when the screen shows an unresolved selection
/// menu, else None. `working` short-circuits: a spinner means real work is
/// happening, so a menu lingering in the scrollback doesn't count.
pub fn classify_needs_input(
    lines: &[String],
    needs_input: &[Regex],
    working: &[Regex],
) -> Option<String> {
    if needs_input.is_empty() {
        return None;
    }
    let text = lines.join("\n");
    if working.iter().any(|re| re.is_match(&text)) {
        return None;
    }
    if !needs_input.iter().any(|re| re.is_match(&text)) {
        return None;
    }
    // Anchor on the LAST line carrying a menu-cursor match, then take a little
    // context above (the question) and below (the options).
    let last = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| needs_input.iter().any(|re| re.is_match(l)))
        .map(|(i, _)| i)
        .next_back()?;
    let start = last.saturating_sub(6);
    let end = (last + 6).min(lines.len());
    let block: Vec<&str> = lines[start..end]
        .iter()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !is_chrome_line(l))
        .collect();
    let joined = block.join(" • ");
    // 400 CHARS (not bytes) — the TS slice is UTF-16-ish but char-truncation is
    // the closest safe equivalent and never splits a multibyte glyph.
    Some(joined.chars().take(400).collect())
}

// ── git snapshot (ts/serve.ts gitStatus) ─────────────────────────────────────

/// Wire-identical to the TS `GitInfo` (ts/subcommands.ts / ts/serve.ts) — the
/// console's gitLabel() reads every one of these fields, so a missing key
/// silently drops a tag from the left rail.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
pub struct GitInfo {
    pub branch: Option<String>,
    pub dirty: bool,
    /// Real file changes — excludes submodule pin-bumps and internal dirt.
    pub changed: u32,
    /// Submodule gitlinks pointing at a new commit — pin-bump/drift.
    pub pins: u32,
    /// Submodule has internal changes but its recorded pin is unchanged.
    #[serde(rename = "subDirty")]
    pub sub_dirty: u32,
    pub ahead: u32,
    pub behind: u32,
}

/// Parse `git status --porcelain=v2 --branch`, mirroring parseGitStatus in
/// ts/subcommands.ts.
///
/// v2 (not v1) because the per-entry submodule field lets us split gitlink
/// churn out of `changed`: in a superproject with many submodules the constant
/// pin drift would otherwise bury the real edits and read as "dirty".
pub fn parse_porcelain_v2(out: &str) -> GitInfo {
    let mut g = GitInfo::default();
    for line in out.split('\n') {
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            // A detached HEAD reports "(detached)" — surfaced as a null branch,
            // exactly like the TS parser.
            g.branch = if rest == "(detached)" { None } else { Some(rest.to_string()) };
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            let mut it = rest.split_whitespace();
            g.ahead = it.next().and_then(|v| v.trim_start_matches('+').parse().ok()).unwrap_or(0);
            g.behind = it.next().and_then(|v| v.trim_start_matches('-').parse().ok()).unwrap_or(0);
        } else if line.starts_with('#') {
            continue;
        } else if line.starts_with('?') || line.starts_with('u') {
            g.changed += 1;
        } else if line.starts_with('1') || line.starts_with('2') {
            // `<kind> <XY> <sub> …` — the third field is the submodule state.
            // "S C.." = the recorded commit changed (a pin bump); any other
            // "S..." is internal dirt; "N..." is an ordinary file.
            let sub: Vec<char> = line.split(' ').nth(2).unwrap_or("N...").chars().collect();
            match (sub.first(), sub.get(1)) {
                (Some('S'), Some('C')) => g.pins += 1,
                (Some('S'), _) => g.sub_dirty += 1,
                _ => g.changed += 1,
            }
        }
    }
    g.dirty = g.changed > 0;
    g
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(lines: &[&str]) -> Vec<String> {
        lines.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn task_counts_needs_anchor_and_two_markers() {
        assert_eq!(parse_task_counts(&v(&["☒ one"])), None);
        assert_eq!(parse_task_counts(&v(&["☒ one", "◻ two"])), None, "no ⎿ anchor");
        assert_eq!(
            parse_task_counts(&v(&["⎿  ☒ one", "   ◼ two", "   ◻ three"])),
            Some(TaskCounts { done: 1, total: 3 })
        );
    }

    #[test]
    fn task_counts_takes_the_most_recent_block() {
        let lines = v(&[
            "⎿  ☒ a", "   ☒ b", "prose", "⎿  ☒ c", "   ◻ d", "   ◻ e",
        ]);
        assert_eq!(parse_task_counts(&lines), Some(TaskCounts { done: 1, total: 3 }));
    }

    #[test]
    fn task_counts_anchor_on_the_line_above() {
        assert_eq!(
            parse_task_counts(&v(&["⎿", "☒ a", "◻ b"])),
            Some(TaskCounts { done: 1, total: 2 })
        );
    }

    #[test]
    fn badges_static_and_dynamic() {
        assert_eq!(match_badges(&v(&["/goal active now"])), vec!["goal-active"]);
        assert_eq!(
            match_badges(&v(&["⏸ manual mode on · 4 shells · ↓ to manage"])),
            vec!["shells:4 shells"]
        );
        assert_eq!(match_badges(&v(&["⏸ x · PR #310"])), vec!["pr:PR #310"]);
        assert_eq!(match_badges(&v(&["⏸ x · ← 3 agents"])), vec!["bg-agents:3 agents"]);
    }

    #[test]
    fn badges_ignore_prose_mentioning_counts() {
        assert!(match_badges(&v(&["I started 4 shells earlier"])).is_empty());
    }

    #[test]
    fn badges_retry_needs_the_full_banner() {
        assert!(match_badges(&v(&["we should add a will retry in 3s backoff"])).is_empty());
        assert_eq!(
            match_badges(&v(&["✻ Waiting for API response · will retry in 2m 17s"])),
            vec!["retrying"]
        );
    }

    #[test]
    fn needs_input_yields_the_menu_text() {
        let ni = vec![Regex::new(r"(?m)❯ ?\d+\.").unwrap()];
        let lines = v(&["Do you want to apply this fix?", "❯ 1. Yes", "  2. No", "─────"]);
        let q = classify_needs_input(&lines, &ni, &[]).unwrap();
        assert!(q.contains("Do you want to apply this fix?"), "{q}");
        assert!(q.contains("❯ 1. Yes"), "{q}");
        assert!(!q.contains("─────"), "chrome must be filtered: {q}");
    }

    #[test]
    fn needs_input_loses_to_working() {
        let ni = vec![Regex::new(r"(?m)❯ ?\d+\.").unwrap()];
        let working = vec![Regex::new(r"esc to interrupt").unwrap()];
        let lines = v(&["❯ 1. Yes", "✶ Thinking… (esc to interrupt)"]);
        assert_eq!(classify_needs_input(&lines, &ni, &working), None);
    }

    #[test]
    fn needs_input_none_without_a_menu() {
        let ni = vec![Regex::new(r"(?m)❯ ?\d+\.").unwrap()];
        assert_eq!(classify_needs_input(&v(&["all done"]), &ni, &[]), None);
    }

    #[test]
    fn git_v2_branch_ahead_behind_and_changed() {
        let out = "# branch.oid abc\n\
                   # branch.head rsserve\n\
                   # branch.ab +2 -1\n\
                   1 .M N... 100644 100644 100644 aaa bbb ts/serve.ts\n\
                   ? tmp/scratch.txt\n";
        let g = parse_porcelain_v2(out);
        assert_eq!(g.branch.as_deref(), Some("rsserve"));
        assert_eq!((g.ahead, g.behind, g.changed, g.dirty), (2, 1, 2, true));
    }

    #[test]
    fn git_v2_splits_pin_bumps_from_internal_submodule_dirt() {
        let out = "# branch.head main\n\
                   1 .M SC.. 160000 160000 160000 aaa bbb lib/pinned\n\
                   1 .M S..U 160000 160000 160000 aaa bbb lib/rgui\n\
                   1 .M N... 100644 100644 100644 aaa bbb a.ts\n";
        let g = parse_porcelain_v2(out);
        assert_eq!((g.changed, g.pins, g.sub_dirty), (1, 1, 1));
    }

    #[test]
    fn git_v2_detached_head_reports_a_null_branch() {
        assert!(parse_porcelain_v2("# branch.head (detached)\n").branch.is_none());
    }

    #[test]
    fn git_v2_serializes_with_the_ts_field_names() {
        let v = serde_json::to_value(parse_porcelain_v2("# branch.head main\n")).unwrap();
        for k in ["branch", "dirty", "changed", "pins", "subDirty", "ahead", "behind"] {
            assert!(v.get(k).is_some(), "missing {k} in {v}");
        }
    }
}
