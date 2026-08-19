//! The one list of CLI names both binaries agree on.
//!
//! This used to be copy-pasted into `cli.rs` (the `agent-yes` binary, which
//! validates `ay <cli>`) and `serve/control.rs` (the `ayrs` daemon, which both
//! advertises the list over `/api/spawn-config` and rejects an unknown `cli` on
//! `/api/spawn`). The two binaries include disjoint module sets — `main.rs` does
//! not pull in `serve/`, and `ayrs.rs` does not pull in `cli.rs` — so neither
//! could `use` the other's copy, and the duplication was load-bearing.
//!
//! Two copies of a list that MUST agree is a drift waiting to happen: a CLI
//! added to one side only would be accepted by `ay` but 400 from the daemon
//! (or offered by the console's picker and then refused at launch). Nothing
//! failed loudly, because each copy is internally consistent.
//!
//! This module has no dependencies beyond `core`, so both binaries can include
//! it with `#[path]` and share the single definition.

/// Every CLI name agent-yes knows how to launch.
///
/// Must stay in step with the `clis:` keys of `default.config.yaml`, which is
/// the ultimate source of truth (it carries each CLI's binary, markers and
/// install command). `cli.rs`'s test asserts that correspondence.
pub const SUPPORTED_CLIS: &[&str] = &[
    "claude",
    "glm",
    "pi",
    "codex",
    "codex-ds",
    "codex-ds-direct",
    "copilot",
    "cursor",
    "grok",
    "qwen",
    "auggie",
    "amp",
    "opencode",
    "dsh",
    "dsh-tui",
    "dsh-legacy",
    "bash",
    "cmd",
    "powershell",
];
