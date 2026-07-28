//! The permission posture an agent was actually spawned with — derived once at
//! registration and stamped into the pid record so it can be audited later.
//!
//! Why record it rather than re-derive on read: the global index carries no
//! argv, and the wrapper's own flags (`--robust`, auto-continue) never appear in
//! the CLI's args at all. Without stamping this, "was this agent running with
//! permission checks disabled?" is unanswerable after the fact — which is
//! exactly the question an operator looking at a fleet of agents needs answered.
//!
//! MIRRORS `ts/agentPermissions.ts` — keep the two in sync (field names are the
//! serialized wire format shared through `~/.agent-yes/pids.jsonl`).
//!
//! Issue #236.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentPermissions {
    /// The wrapped CLI got its "yolo" flag — the per-CLI `yes_args` appended by
    /// `-y`/`--yes`, or the same flag passed through directly. This is the one
    /// that matters for audit: it disables the CLI's own confirmation gate, so
    /// the agent edits files and runs commands with no human in the loop.
    pub skip_permissions: bool,
    /// agent-yes `--robust`: restart the CLI automatically when it crashes.
    pub robust: bool,
    /// agent-yes auto-continue: resume the prior session on restart.
    pub auto_continue: bool,
}

/// Flags that disable a CLI's confirmation gate, recognised regardless of what
/// `yes_args` the config declares.
///
/// The configured `yes_args` are the flags `-y` APPENDS; a user is free to pass
/// the same flag directly, and a config that omits `yes_args` entirely (some
/// CLIs deliberately have none) must not make a genuinely dangerous flag
/// invisible. So the check is the union: configured flags OR any of these.
const DANGEROUS_FLAGS: &[&str] = &[
    "--dangerously-skip-permissions",
    "--dangerously-bypass-approvals-and-sandbox",
    "--yolo",
    "--full-auto",
];

/// `--flag=value` and `--flag value` must compare equal — match on the flag part.
fn flag_name(arg: &str) -> &str {
    match arg.find('=') {
        Some(i) => &arg[..i],
        None => arg,
    }
}

pub fn derive_permissions(
    cli_args: &[String],
    yes_args: &[String],
    robust: bool,
    auto_continue: bool,
) -> AgentPermissions {
    let skip_permissions = cli_args.iter().any(|a| {
        let name = flag_name(a);
        DANGEROUS_FLAGS.contains(&name) || yes_args.iter().any(|y| flag_name(y) == name)
    });
    AgentPermissions {
        skip_permissions,
        robust,
        auto_continue,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn test_detects_the_configured_yolo_flag() {
        let p = derive_permissions(
            &v(&["--print", "--dangerously-skip-permissions"]),
            &v(&["--dangerously-skip-permissions"]),
            false,
            false,
        );
        assert!(p.skip_permissions);
    }

    #[test]
    fn test_detects_a_dangerous_flag_the_config_never_declared() {
        // A CLI with no yes_args must still not hide a flag that disables its gate.
        let p = derive_permissions(&v(&["--yolo"]), &[], false, false);
        assert!(p.skip_permissions);
    }

    #[test]
    fn test_matches_the_flag_part_of_an_equals_form() {
        let p = derive_permissions(&v(&["--full-auto=true"]), &[], false, false);
        assert!(p.skip_permissions);
    }

    #[test]
    fn test_plain_args_are_not_skip() {
        let p = derive_permissions(
            &v(&["--model", "opus", "--continue"]),
            &v(&["--dangerously-skip-permissions"]),
            false,
            false,
        );
        assert!(!p.skip_permissions);
    }

    #[test]
    fn test_a_value_that_merely_looks_like_a_flag_is_not_a_flag_match() {
        // The flag lives in the args as a VALUE here, so it is still present in
        // argv — we deliberately flag it: an audit must be conservative.
        let p = derive_permissions(&v(&["--note", "--yolo"]), &[], false, false);
        assert!(p.skip_permissions);
    }

    #[test]
    fn test_wrapper_flags_are_recorded_independently() {
        let p = derive_permissions(&[], &[], true, true);
        assert!(!p.skip_permissions);
        assert!(p.robust);
        assert!(p.auto_continue);
    }

    #[test]
    fn test_serializes_with_the_shared_wire_names() {
        // The TS runtime reads these exact keys out of pids.jsonl.
        let json = serde_json::to_string(&derive_permissions(&[], &[], true, false)).unwrap();
        assert!(json.contains("\"skip_permissions\":false"));
        assert!(json.contains("\"robust\":true"));
        assert!(json.contains("\"auto_continue\":false"));
    }
}
