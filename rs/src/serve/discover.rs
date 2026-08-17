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
    let Ok(raw) = std::fs::read_to_string(path) else {
        return vec![];
    };
    raw.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// How far back a windowed scan reads. The edge views keep only records newer
/// than `READ_WINDOW_MS`, so everything before that is parsed and thrown away:
/// on one live fleet a single `/api/edges` parsed 22 MB across 43 outboxes and
/// kept **one** line — twice a second, per viewer. 256 KB is orders of
/// magnitude more than a minute of traffic produces, and still one read.
const TAIL_SCAN_BYTES: u64 = 256 * 1024;

/// `read_jsonl` for append-only logs that are only ever consumed through a
/// recent time window. Two bounds, in order of how much they save:
///
///  1. **mtime gate** — a file last written before the window opened cannot
///     hold an in-window record, because `at` is stamped when the line is
///     appended, so mtime is never older than the newest `at`. Such a file is
///     skipped without being opened. On a fleet where most agents are idle
///     this drops nearly every file.
///  2. **bounded backscan** — read at most the trailing `TAIL_SCAN_BYTES`
///     rather than the whole file, dropping the leading partial line whenever
///     the read didn't start at offset 0.
///
/// Deliberately NOT "stop at the first out-of-window line": several agents
/// append to one project's outbox concurrently, so `at` is not monotonic
/// between adjacent lines and an early break can miss a record a slower writer
/// interleaved. Scanning the whole window stays cheap once the window is
/// bounded in bytes.
fn read_jsonl_window(path: &std::path::Path, now: i64, window_ms: i64) -> Vec<Value> {
    let Ok(meta) = std::fs::metadata(path) else {
        return vec![];
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    // mtime == 0 means "couldn't read it" — scan rather than silently skip. A
    // future-dated mtime (clock skew) also falls through to the scan.
    if mtime > 0 && now - mtime > window_ms {
        return vec![];
    }
    let size = meta.len();
    let start = size.saturating_sub(TAIL_SCAN_BYTES);
    let Ok(mut f) = std::fs::File::open(path) else {
        return vec![];
    };
    use std::io::{Read, Seek, SeekFrom};
    if f.seek(SeekFrom::Start(start)).is_err() {
        return vec![];
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return vec![];
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.lines();
    if start > 0 {
        lines.next(); // partial first line — the tail of an earlier record
    }
    lines
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
        let Some(pid) = v.get("pid").and_then(|p| p.as_i64()) else {
            continue;
        };
        match v
            .get("note")
            .and_then(|n| n.as_str())
            .filter(|s| !s.is_empty())
        {
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
    for v in read_jsonl_window(&home.join("reads.jsonl"), now, READ_WINDOW_MS) {
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
        for rec in read_jsonl_window(
            &std::path::Path::new(cwd)
                .join(".agent-yes")
                .join("outbox.jsonl"),
            now,
            READ_WINDOW_MS,
        ) {
            let Some(at) = rec.get("at").and_then(|x| x.as_i64()) else {
                continue;
            };
            if now - at > READ_WINDOW_MS {
                continue;
            }
            let by = rec
                .get("from")
                .and_then(|f| f.get("pid"))
                .and_then(|p| p.as_i64());
            let target = rec
                .get("to")
                .and_then(|f| f.get("pid"))
                .and_then(|p| p.as_i64());
            let (Some(by), Some(target)) = (by, target) else {
                continue;
            };
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
    let lo = (0..=idx.saturating_sub(60))
        .rev()
        .find(|i| text.is_char_boundary(*i))
        .unwrap_or(0);
    let want = (idx + ql.len() + 60).min(text.len());
    let hi = (want..=text.len())
        .find(|i| text.is_char_boundary(*i))
        .unwrap_or(text.len());
    let snippet = text[lo..hi]
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
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

    // ---- read_jsonl_window ---------------------------------------------------

    /// Write `body` and stamp the file's mtime `age_ms` into the past, which is
    /// what the mtime gate keys off.
    fn write_aged(path: &std::path::Path, body: &str, age_ms: u64) {
        std::fs::write(path, body).unwrap();
        let when = std::time::SystemTime::now() - std::time::Duration::from_millis(age_ms);
        let f = std::fs::File::options().write(true).open(path).unwrap();
        f.set_modified(when).unwrap();
    }

    #[test]
    fn window_scan_skips_a_file_whose_mtime_predates_the_window() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("outbox.jsonl");
        let now = now_ms();
        // In-window CONTENT, out-of-window mtime. The gate must still skip it:
        // an append stamps both, so this combination cannot occur in practice,
        // and asserting on it is what proves the read was actually elided.
        write_aged(&p, &format!("{{\"at\":{now}}}\n"), 10 * 60_000);
        assert!(read_jsonl_window(&p, now, READ_WINDOW_MS).is_empty());
    }

    #[test]
    fn window_scan_reads_a_recently_written_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("outbox.jsonl");
        let now = now_ms();
        write_aged(&p, &format!("{{\"at\":{now},\"n\":1}}\n"), 0);
        let got = read_jsonl_window(&p, now, READ_WINDOW_MS);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["n"], json!(1));
    }

    #[test]
    fn window_scan_keeps_the_tail_and_drops_the_partial_first_line() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("outbox.jsonl");
        let now = now_ms();
        // Overshoot TAIL_SCAN_BYTES with padded records so the read starts
        // mid-line, then assert the last record survives and the count is
        // bounded by the scan window rather than the file.
        let pad = "x".repeat(4096);
        let mut body = String::new();
        for i in 0..200 {
            body.push_str(&format!("{{\"at\":{now},\"n\":{i},\"pad\":\"{pad}\"}}\n"));
        }
        write_aged(&p, &body, 0);
        assert!(std::fs::metadata(&p).unwrap().len() > TAIL_SCAN_BYTES);
        let got = read_jsonl_window(&p, now, READ_WINDOW_MS);
        assert!(!got.is_empty());
        assert_eq!(got.last().unwrap()["n"], json!(199));
        assert!(got.len() < 200, "scan was not bounded: {} lines", got.len());
        // Every parsed line is whole — a partial leading line would fail to
        // deserialize and be dropped silently, so check the first one directly.
        assert!(got[0]["n"].is_number());
    }

    #[test]
    fn window_scan_tolerates_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("nope.jsonl");
        assert!(read_jsonl_window(&p, now_ms(), READ_WINDOW_MS).is_empty());
    }

    #[test]
    fn message_edges_still_reports_a_fresh_send() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("repo-alpha");
        std::fs::create_dir_all(cwd.join(".agent-yes")).unwrap();
        let now = now_ms();
        write_aged(
            &cwd.join(".agent-yes").join("outbox.jsonl"),
            &format!(
                "{{\"at\":{},\"from\":{{\"pid\":1111}},\"to\":{{\"pid\":2222}},\"kind\":\"send\"}}\n",
                now - 1_000
            ),
            0,
        );
        let edges = message_edges(&[cwd.to_string_lossy().to_string()]);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0]["by"], json!(1111));
        assert_eq!(edges[0]["target"], json!(2222));
        assert_eq!(edges[0]["kind"], json!("send"));
    }

    #[test]
    fn message_edges_drops_a_stale_outbox() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("repo-alpha");
        std::fs::create_dir_all(cwd.join(".agent-yes")).unwrap();
        let now = now_ms();
        write_aged(
            &cwd.join(".agent-yes").join("outbox.jsonl"),
            &format!(
                "{{\"at\":{},\"from\":{{\"pid\":1111}},\"to\":{{\"pid\":2222}}}}\n",
                now - 10 * 60_000
            ),
            10 * 60_000,
        );
        assert!(message_edges(&[cwd.to_string_lossy().to_string()]).is_empty());
    }
}
