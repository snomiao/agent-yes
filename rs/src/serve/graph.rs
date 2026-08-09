// GET /api/graph — the fleet as a read-only federated rgui graph envelope
// (org.rgui.graph.v1). Port of the handler in ts/serve.ts.
//
// A REDACTED projection of /api/ls: pid, cli type, status and the parent/subagent
// shape only. No cwd, prompt, question, or terminal bytes leave through this
// route — the `preview` renderHint (which DOES carry screen lines in the TS
// daemon, redacted at the source) is deliberately omitted here rather than
// re-implemented with weaker redaction.

use crate::pid_store::PidRecord;
use serde_json::{json, Value};

const NODE_W: i64 = 520;

/// Node box sized to the agent's REAL PTY aspect, so a consumer that derives
/// height from width (otoji chain slots) shows the embed without letterboxing.
/// Terminal cells are ~1:2 (w:h), so px aspect = cols / (2 * rows).
fn size_of(size: Option<(u16, u16)>) -> Value {
    let aspect = match size {
        Some((c, r)) if c > 0 && r > 0 => c as f64 / (2.0 * r as f64),
        _ => 2.0,
    };
    let h = ((NODE_W as f64 / aspect).max(96.0))
        .min(NODE_W as f64 * 2.0)
        .round() as i64;
    json!({ "w": NODE_W, "h": h })
}

pub struct GraphInput<'a> {
    pub records: &'a [PidRecord],
    pub hostname: String,
    /// Recent agent→agent read edges (as produced by discover::read_edges).
    pub reads: Vec<Value>,
    /// PTY size per pid, for node aspect.
    pub sizes: std::collections::HashMap<u32, (u16, u16)>,
}

pub fn build(input: GraphInput) -> Value {
    // ONE namespace for the whole feed: ns == every node id's prefix, so a
    // consumer can enforce "a feed only speaks for its own namespace" with a
    // plain prefix check. The machine name is metadata, NOT part of the ns.
    let origin = "agent-yes";
    let ns = format!("ay://{origin}");
    let host = &input.hostname;
    let owner = format!("agent-yes:{host}");
    let nid = |pid: u32| format!("{ns}/{pid}");
    let env_node_id = format!("{ns}/env-{host}");
    let text_in = json!({ "id": "text-in", "label": "text", "kind": "text" });
    let text_out = json!({ "id": "text-out", "label": "text", "kind": "text" });
    let env_in = json!({ "id": "env", "label": "env", "kind": "environment" });
    let env_out = json!({ "id": "env", "label": "env", "kind": "environment" });

    // A record's parent is recorded as the parent's WRAPPER pid; map it back to
    // the parent agent's own pid so the containment edge lands on a real node.
    let by_wrapper: std::collections::HashMap<u32, u32> = input
        .records
        .iter()
        .map(|r| (r.wrapper_pid.unwrap_or(r.pid), r.pid))
        .collect();

    let mut nodes: Vec<Value> = input
        .records
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let parent = r
                .parent_pid
                .and_then(|p| by_wrapper.get(&p))
                .map(|p| Value::String(nid(*p)))
                .unwrap_or(Value::Null);
            json!({
                "id": nid(r.pid),
                "app": "agent-yes",
                "type": format!("{}-agent", r.cli),
                "title": format!("{} #{}", r.cli, r.pid),
                "category": "agent-yes",
                "owner": owner,
                "status": r.status,
                "parent": parent,
                "pos": { "x": (i as i64 % 8) * (NODE_W + 64), "y": (i as i64 / 8) * 480 },
                "size": size_of(input.sizes.get(&r.pid).copied()),
                "inputs": [text_in, env_in],
                "outputs": [text_out],
                // What this agent is permitted to do, stamped at spawn. Carried
                // so the viewer can badge the env edge; null (→ "unknown", not
                // "safe") for agents registered before the stamp existed.
                "configPublic": { "permissions": r.permissions },
            })
        })
        .collect();

    // The host environment node: identity + capability flags only (no cwd, no
    // load numbers — health telemetry stays behind /api/host).
    nodes.push(json!({
        "id": env_node_id,
        "app": "agent-yes",
        "type": "environment",
        "title": format!("env @ {host}"),
        "category": "environment",
        "owner": owner,
        "status": "active",
        "parent": Value::Null,
        "pos": { "x": -NODE_W - 96, "y": 0 },
        "size": { "w": NODE_W, "h": 160 },
        "inputs": [],
        "outputs": [env_out],
        "configPublic": {
            "scope": "native-device",
            "runtime": "native",
            "caps": {
                "send": true, "kill": true, "spawn": true,
                // Provisioning is native (rs/src/serve/ws.rs); no JS spawn hook.
                "spawnHook": false, "provision": true, "skipPermissions": false,
            },
        },
    }));

    // The newest codex agent is ALSO exposed under the shared demo-chain id so
    // cross-system edges have a stable target.
    let codex = input
        .records
        .iter()
        .filter(|r| r.cli == "codex")
        .max_by_key(|r| r.started_at);
    nodes.push(json!({
        "id": "ay://agent-yes/codex-agent",
        "app": "agent-yes",
        "type": "codex-agent",
        "title": "Codex Agent",
        "category": "agent-yes",
        "owner": owner,
        "status": codex.map(|r| r.status.clone()).unwrap_or_else(|| "offline".into()),
        "parent": Value::Null,
        "pos": { "x": 0, "y": -560 },
        "size": codex
            .map(|r| size_of(input.sizes.get(&r.pid).copied()))
            .unwrap_or_else(|| json!({ "w": NODE_W, "h": 260 })),
        "inputs": [text_in, env_in],
        "outputs": [text_out],
    }));

    let present: std::collections::HashSet<String> = nodes
        .iter()
        .filter_map(|n| n["id"].as_str().map(String::from))
        .collect();

    // read edges: target's output → reader's input (the reader pulls).
    let mut edges: Vec<Value> = input
        .reads
        .iter()
        .filter_map(|e| {
            let (by, target) = (e["by"].as_i64()? as u32, e["target"].as_i64()? as u32);
            if by == target || !present.contains(&nid(target)) || !present.contains(&nid(by)) {
                return None;
            }
            Some(json!({
                "source": { "node": nid(target), "port": "text-out", "type": "text" },
                "target": { "node": nid(by), "port": "text-in", "type": "text" },
                "status": "readonly",
                "label": "reads",
            }))
        })
        .collect();

    // env wiring: host environment → each ROOT agent. Children inherit the
    // environment through containment, so wiring every agent would be noise.
    for n in &nodes {
        let id = n["id"].as_str().unwrap_or_default();
        if id == env_node_id || !n["parent"].is_null() {
            continue;
        }
        edges.push(json!({
            "source": { "node": env_node_id, "port": "env", "type": "environment" },
            "target": { "node": id, "port": "env", "type": "environment" },
            "status": "readonly",
        }));
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let node_types: Vec<String> = {
        let mut seen = Vec::new();
        for n in &nodes {
            if let Some(t) = n["type"].as_str() {
                if !seen.iter().any(|s| s == t) {
                    seen.push(t.to_string());
                }
            }
        }
        seen
    };
    json!({
        "kind": "rgui-federated-graph",
        "schema": "org.rgui.graph.v1",
        "producer": {
            "app": "ay",
            "origin": origin,
            "deviceId": host,
            "label": format!("agent-yes fleet @ {host}"),
        },
        "revision": now,
        "ts": now,
        "graph": { "nodes": nodes, "edges": edges },
        "capabilities": { "nodeTypes": node_types, "portTypes": ["text", "environment"] },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(pid: u32, cli: &str, wrapper: Option<u32>, parent: Option<u32>) -> PidRecord {
        let mut r: PidRecord = serde_json::from_value(json!({
            "pid": pid, "cli": cli, "prompt": Value::Null, "cwd": "/ws",
            "log_file": Value::Null, "status": "active", "exit_code": Value::Null,
            "exit_reason": Value::Null, "started_at": 0,
        }))
        .unwrap();
        r.wrapper_pid = wrapper;
        r.parent_pid = parent;
        r
    }

    fn build_with(records: &[PidRecord], reads: Vec<Value>) -> Value {
        build(GraphInput {
            records,
            hostname: "tak".into(),
            reads,
            sizes: Default::default(),
        })
    }

    #[test]
    fn every_node_id_lives_in_the_producer_namespace() {
        let g = build_with(&[rec(1, "claude", None, None)], vec![]);
        for n in g["graph"]["nodes"].as_array().unwrap() {
            let id = n["id"].as_str().unwrap();
            assert!(id.starts_with("ay://agent-yes"), "{id}");
        }
    }

    #[test]
    fn parent_resolves_through_the_wrapper_pid() {
        // child.parent_pid points at the PARENT'S WRAPPER, not its agent pid.
        let recs = [
            rec(10, "claude", Some(9), None),
            rec(20, "claude", None, Some(9)),
        ];
        let g = build_with(&recs, vec![]);
        let child = g["graph"]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == "ay://agent-yes/20");
        assert_eq!(child.unwrap()["parent"], json!("ay://agent-yes/10"));
    }

    #[test]
    fn env_edges_go_to_root_agents_only() {
        let recs = [
            rec(10, "claude", Some(9), None),
            rec(20, "claude", None, Some(9)),
        ];
        let g = build_with(&recs, vec![]);
        let env: Vec<&Value> = g["graph"]["edges"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["source"]["type"] == "environment")
            .collect();
        let targets: Vec<&str> = env
            .iter()
            .map(|e| e["target"]["node"].as_str().unwrap())
            .collect();
        assert!(targets.contains(&"ay://agent-yes/10"));
        assert!(
            !targets.contains(&"ay://agent-yes/20"),
            "child must inherit, not be wired"
        );
    }

    #[test]
    fn read_edges_are_dropped_when_either_end_is_absent() {
        let recs = [rec(10, "claude", None, None)];
        let g = build_with(&recs, vec![json!({"by": 10, "target": 999, "at": 0})]);
        assert!(!g["graph"]["edges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["label"] == "reads"));
    }

    #[test]
    fn redacts_cwd_and_prompt() {
        let mut r = rec(1, "claude", None, None);
        r.cwd = "/secret/path".into();
        r.prompt = Some("do not leak".into());
        let s = build_with(&[r], vec![]).to_string();
        assert!(!s.contains("/secret/path"), "cwd leaked");
        assert!(!s.contains("do not leak"), "prompt leaked");
    }

    #[test]
    fn node_height_follows_the_pty_aspect() {
        let mut sizes = std::collections::HashMap::new();
        sizes.insert(1u32, (80u16, 24u16));
        let g = build(GraphInput {
            records: &[rec(1, "claude", None, None)],
            hostname: "tak".into(),
            reads: vec![],
            sizes,
        });
        // 520 / (80 / 48) = 312
        assert_eq!(g["graph"]["nodes"][0]["size"]["h"], json!(312));
    }
}
