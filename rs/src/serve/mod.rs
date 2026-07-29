// `ayrs serve` — pure-Rust port of the ay-serve WebRTC share host. Kept as a
// separate binary/module tree so it can coexist with the TS `ay serve` daemon
// during the migration: it persists its room in `.share-room-ayrs` (NOT the TS
// `.share-room`), so both hosts can run side by side without fighting over the
// signaling room, while sharing the same pids.jsonl / logs / fifos data plane.
pub mod api;
pub mod e2e;
pub mod meta;
pub mod nego;
pub mod service;
pub mod share;
