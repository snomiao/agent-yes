// Read-only fleet-introspection routes: /api/notes, /api/edges, /api/asks,
// /api/search. Ports of the corresponding handlers in ts/serve.ts, reading the
// same on-disk stores so both daemons report identical state.

use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

/// "read recently" window for the relationship-wire view (READ_WINDOW_MS).
const READ_WINDOW_MS: i64 = 60_000;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn read_jsonl(path: &std::path::Path) -> Vec<Value> {
    let Ok(raw) = std::fs::read_to_string(path) else { return vec![] };
    raw.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// GET /api/notes — pid → note, from the append-only ~/.agent-yes/notes.jsonl
/// (last line wins; an empty note deletes the entry).
pub fn notes(home: &std::path::Path) -> Value {
    let mut map = Map::new();
    for v in read_jsonl(&home.join("notes.jsonl")) {
        let Some(pid) = v.get("pid").and_then(|p| p.as_i64()) else { continue };
        match v.get("note").and_then(|n| n.as_str()).filter(|s| !s.is_empty()) {
            Some(note) => {
                map.insert(pid.to_string(), json!(note));
            }
            None => {
                map.remove(&pid.to_string());
            }
        }
    }
    Value::Object(map)
}

/// Recent agent→agent read/tail edges from ~/.agent-yes/reads.jsonl. Human
/// readers (`by` without the "agent:" prefix) are skipped — the wire view shows
/// agents watching each other, not people watching agents.
pub fn read_edges(home: &std::path::Path) -> Vec<Value> {
    let now = now_ms();
    // Append-only log, last write per (by, target) wins.
    let mut latest: HashMap<(String, i64), i64> = HashMap::new();
    for v in read_jsonl(&home.join("reads.jsonl")) {
        let (Some(by), Some(target), Some(at)) = (
            v.get("by").and_then(|x| x.as_str()),
            v.get("target").and_then(|x| x.as_i64()),
            v.get("at").and_then(|x| x.as_i64()),
        ) else {
            continue;
        };
        let e = latest.entry((by.to_string(), target)).or_insert(at);
        *e = (*e).max(at);
    }
    latest
        .into_iter()
        .filter(|(_, at)| now - at <= READ_WINDOW_MS)
        .filter_map(|((by, target), at)| {
            let by_pid: i64 = by.strip_prefix("agent:")?.parse().ok()?;
            (by_pid != 0 && target != 0 && by_pid != target)
                .then(|| json!({ "by": by_pid, "target": target, "at": at }))
        })
        .collect()
}

/// Recent agent→agent MESSAGE edges (a delivered `ay send`/`key`/`select`),
/// scanned from each live agent's per-cwd outbox. Bounded by the number of
/// distinct cwds — the outbox is per-cwd, so each dir is read once.
pub fn message_edges(cwds: &[String]) -> Vec<Value> {
    let now = now_ms();
    let mut best: HashMap<(i64, i64), (i64, Option<String>)> = HashMap::new();
    for cwd in cwds.iter().collect::<HashSet<_>>() {
        for rec in read_jsonl(&std::path::Path::new(cwd).join(".agent-yes").join("outbox.jsonl")) {
            let Some(at) = rec.get("at").and_then(|x| x.as_i64()) else { continue };
            if now - at > READ_WINDOW_MS {
                continue;
            }
            let by = rec.get("from").and_then(|f| f.get("pid")).and_then(|p| p.as_i64());
            let target = rec.get("to").and_then(|f| f.get("pid")).and_then(|p| p.as_i64());
            let (Some(by), Some(target)) = (by, target) else { continue };
            if by == 0 || target == 0 || by == target {
                continue; // agent→agent only
            }
            let kind = rec.get("kind").and_then(|k| k.as_str()).map(String::from);
            let slot = best.entry((by, target)).or_insert((at, kind.clone()));
            if at >= slot.0 {
                *slot = (at, kind);
            }
        }
    }
    best.into_iter()
        .map(|((by, target), (at, kind))| {
            let mut o = json!({ "by": by, "target": target, "at": at });
            if let Some(k) = kind {
                o["kind"] = json!(k);
            }
            o
        })
        .collect()
}

// NOTE: /api/asks + /api/asks/answer are deliberately NOT ported. They are not
// a log format we can read — they project a per-project todo STORE (see
// ts/askApi.ts openStore / answerAsk, with blockRev optimistic concurrency and
// atomic transition advancement). Re-implementing that store from the outside
// would risk corrupting it, so those routes stay on `ay serve`.

/// Locate the latest occurrence of `ql` in `text` and build the console's
/// snippet: 60 chars of context either side, whitespace collapsed. The LATEST
/// occurrence is used because the most recent mention reads as most relevant.
fn snippet_at(text: &str, ql: &str) -> Option<(usize, String)> {
    let idx = text.to_lowercase().rfind(ql)?;
    // Byte indices from the lowercased copy can land mid-char in the original
    // (lowercasing can change byte length), so clamp to char boundaries.
    let lo = (0..=idx.saturating_sub(60)).rev().find(|i| text.is_char_boundary(*i)).unwrap_or(0);
    let want = (idx + ql.len() + 60).min(text.len());
    let hi = (want..=text.len()).find(|i| text.is_char_boundary(*i)).unwrap_or(text.len());
    let snippet = text[lo..hi].split_whitespace().collect::<Vec<_>>().join(" ");
    Some((idx, snippet))
}

/// One search hit over an agent's rendered screen text.
pub fn search_hit(pid: u32, cli: &str, cwd: &str, text: &str, ql: &str) -> Option<Value> {
    let (idx, snippet) = snippet_at(text, ql)?;
    Some(json!({ "pid": pid, "cli": cli, "cwd": cwd, "snippet": snippet, "match_at": idx }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(dir: &std::path::Path, name: &str, lines: &[Value]) {
        std::fs::create_dir_all(dir).unwrap();
        let mut f = std::fs::File::create(dir.join(name)).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
    }

    #[test]
    fn notes_last_line_wins_and_empty_deletes() {
        let d = tempfile::tempdir().unwrap();
        write(
            d.path(),
            "notes.jsonl",
            &[
                json!({"pid": 1, "note": "first"}),
                json!({"pid": 1, "note": "second"}),
                json!({"pid": 2, "note": "keep"}),
                json!({"pid": 2, "note": ""}),
            ],
        );
        let n = notes(d.path());
        assert_eq!(n["1"], json!("second"));
        assert!(n.get("2").is_none(), "an empty note must delete the entry");
    }

    #[test]
    fn notes_missing_file_is_empty() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(notes(d.path()), json!({}));
    }

    #[test]
    fn read_edges_keep_fresh_agent_pairs_only() {
        let d = tempfile::tempdir().unwrap();
        let now = now_ms();
        write(
            d.path(),
            "reads.jsonl",
            &[
                json!({"by": "agent:10", "target": 20, "at": now}),
                json!({"by": "human", "target": 20, "at": now}),
                json!({"by": "agent:30", "target": 40, "at": now - 120_000}),
                json!({"by": "agent:50", "target": 50, "at": now}),
            ],
        );
        let e = read_edges(d.path());
        assert_eq!(e.len(), 1, "{e:?}");
        assert_eq!(e[0]["by"], json!(10));
        assert_eq!(e[0]["target"], json!(20));
    }

    #[test]
    fn message_edges_keep_the_newest_per_pair() {
        let d = tempfile::tempdir().unwrap();
        let now = now_ms();
        write(
            &d.path().join(".agent-yes"),
            "outbox.jsonl",
            &[
                json!({"at": now - 500, "from": {"pid": 1}, "to": {"pid": 2}, "kind": "key"}),
                json!({"at": now, "from": {"pid": 1}, "to": {"pid": 2}, "kind": "select"}),
                json!({"at": now - 999_999, "from": {"pid": 3}, "to": {"pid": 4}}),
            ],
        );
        let e = message_edges(&[d.path().to_string_lossy().into_owned()]);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0]["kind"], json!("select"));
    }

    #[test]
    fn search_snippet_uses_the_latest_occurrence() {
        let text = "first widget here\n".to_string() + &"x".repeat(300) + "\nlast widget there";
        let h = search_hit(7, "claude", "/ws", &text, "widget").unwrap();
        assert_eq!(h["pid"], json!(7));
        assert!(h["snippet"].as_str().unwrap().contains("last widget there"));
        assert!(h["match_at"].as_i64().unwrap() > 300);
    }

    #[test]
    fn search_snippet_collapses_whitespace_and_misses_return_none() {
        let h = search_hit(1, "claude", "/ws", "a\n\n  needle   \t b", "needle").unwrap();
        assert_eq!(h["snippet"], json!("a needle b"));
        assert!(search_hit(1, "claude", "/ws", "nothing here", "needle").is_none());
    }

    #[test]
    fn search_snippet_survives_multibyte_context() {
        // A naive byte-offset window would split these and panic.
        let text = "日本語のテキストがたくさん並んでいる状態で needle を探す 日本語";
        let h = search_hit(1, "claude", "/ws", text, "needle").unwrap();
        assert!(h["snippet"].as_str().unwrap().contains("needle"));
    }
}
