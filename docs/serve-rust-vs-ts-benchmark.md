# Serve daemon benchmark — Rust `ayrs serve` vs TypeScript `ay serve`

A/B comparison of the two browser-console host daemons running on the **same
machine**, serving the **same local agent fleet**. Room `r2d058f` is hosted by
the Bun/Node TS `ay serve`; room `r7bcb6271a973` by the standalone Rust
`ayrs serve --webrtc`. Both read the same `~/.agent-yes/pids.jsonl` and relay to
the same agent FIFOs, so the only variable is the serve implementation.

Measured 2026-08-01 on the primary dev host (v1.251.0), with the TS serve at its
real ~40% CPU (the live daemon this session runs under) — i.e. an _under-load_
comparison, the condition where console jank is actually felt.

## Results

### Open-time — cold WebRTC connect + first relayed request (5 interleaved trials)

| daemon              | median      | range                   |
| ------------------- | ----------- | ----------------------- |
| TS `ay serve` (bun) | **1466 ms** | 1274–2525 ms (fat tail) |
| Rust `ayrs serve`   | **357 ms**  | 339–467 ms (tight)      |

→ **ayrs ~4.1× faster to open**, with far lower variance.

### Warm request latency — 30 interleaved `/api/ls` calls on each daemon's localhost HTTP endpoint

Isolates the daemon's request-handling (localhost connect is common-mode ~0 and
cancels). Both authenticate with the shared `~/.agent-yes/.serve-token` bearer.

| daemon              | p50        | p95          | max    |
| ------------------- | ---------- | ------------ | ------ |
| TS `ay serve` (bun) | 26.5 ms    | **162.7 ms** | 174 ms |
| Rust `ayrs serve`   | **9.1 ms** | **24.3 ms**  | 61 ms  |

→ **ayrs ~2.9× faster at p50, ~6.7× faster at p95.**

### Resource cost (live)

| daemon              | RSS     | CPU (under load) |
| ------------------- | ------- | ---------------- |
| TS `ay serve` (bun) | ~250 MB | ~40%             |
| Rust `ayrs serve`   | ~33 MB  | ~0.3%            |

→ **~8× less memory**, a fraction of the CPU.

## Interpretation

The **p95 gap is the headline** — TS's warm-latency tail (163 ms vs 24 ms) is the
single-JS-event-loop contention behind the console jank we chased throughout this
work (same mechanism as the browser perf-beacon `req.end` p95 → 16 s observed
earlier under real viewer load). The Bun daemon funnels fan-in from all agents +
fan-out to all viewers + in-process WebRTC through one event loop; under load its
request latency fans into a fat tail. The Rust daemon has no shared JS event loop
to stall, so it stays tight.

`ayrs` wins on **every** axis measured — open-time, p50, p95, memory, CPU — which
makes it the clear cutover target. Retiring the TS `ay serve` is where the win
lands (250 MB → 33 MB, and the event-loop bottleneck goes away).

## Coexistence (no conflict)

Running both simultaneously does **not** conflict:

- **Room persistence** — `.share-room` (TS) vs `.share-room-ayrs` (Rust): different
  files, different rooms (by design, `rs/src/serve/share.rs`).
- **Ports** — TS binds `:7432`; `ayrs serve --webrtc` binds nothing (WebRTC-only).
- **Pid index** — both read `pids.jsonl` read-only.
- **Agent FIFOs** — the agent owns the single reader; both hosts are just
  producers on `send`, same as two viewers on one host.

Incremental cost of adding `ayrs` beside the TS serve: ~+33 MB, ~0% idle CPU, one
extra (hibernating) signaling WebSocket.

## Build-speed: fast dev-iteration paths

The default `bun run build:rs` (`cargo install --path rs --features swarm`,
release + full LTO) is slow to iterate on. Benchmarked incremental rebuild (touch
one source file, rebuild the `ayrs` bin):

| build                                           | incremental | vs default |
| ----------------------------------------------- | ----------- | ---------- |
| default: `cargo install`, release + LTO + swarm | ~145 s      | 1×         |
| `cargo build`, release, **LTO off**, swarm      | ~27 s       | 5.4×       |
| `cargo build`, release, LTO off, **no swarm**   | ~26 s       | 5.6×       |
| `cargo build`, **dev profile (opt0)**, no swarm | ~3 s        | **48×**    |

Two independent causes, both large:

1. **`cargo install` can't reuse the incremental cache** — it builds in a temp
   target dir, so it rebuilds the whole graph (~110 s) even when `cargo build`
   (which reuses `rs/target`) is ~27 s. The fast paths use `cargo build` + copy.
2. **Full LTO dominates the rest** — it relinks the entire webrtc binary on every
   change (145 s → 27 s just from `LTO off`). `swarm` barely affects _incremental_
   time (its ~65 libp2p crates are already cached) but matters on clean builds;
   `ayrs` doesn't use libp2p, so the fast paths drop it.

Shipped as `scripts/build-rs.ts` flags (default build unchanged for CI/shipping):

- **`bun run build:rs:fast`** — release, LTO off, ayrs-only → ~27 s. Still
  opt-level 3, so the binary is a legit optimized console host, safe to run.
- **`bun run build:rs:dev`** — dev profile (opt0), ayrs-only → ~3 s. Unoptimized;
  for rapid correctness iteration, not a production host.

Both `cargo build` + atomic-rename the binary over `~/.cargo/bin/ayrs` (an
in-place copy would `ETXTBSY` when the dest is a running `ayrs serve`).

Applied to the release profile: `lto = "thin"` (was `lto = true` / fat LTO). Thin
LTO links far faster with ~90% of the runtime benefit — negligible for an
I/O-bound WebRTC daemon (time in syscalls/network, not hot compute). Measured: the
release+swarm incremental build dropped from **145s → 72s (2×)**, and this also
speeds up every clean/CI build.

## Method notes / caveats

- Open-time includes the real WebRTC handshake (real-world open cost); warm
  latency is localhost (isolates daemon request-handling). Both point the same way.
- The browser-authentic warm tail (perf-beacon `req.end` p50/p95 over the live
  datachannel) was not captured this round — the rechrome instrument wedged
  mid-run. Worth re-running that slice once rechrome is recovered for a
  fully browser-side confirmation.
- `ayrs serve install` targets a native OS service (systemd `--user` on Linux) and
  fails on this host: it writes the unit but `systemctl --user daemon-reload` fails
  (no user D-Bus in this container). The **working supervision path here is oxmgr**
  (the same manager that ran the TS `ay serve`), registered directly:

  ```
  oxmgr start "$(which ayrs) serve --webrtc" --name ayrs-serve --restart always --max-restarts 20
  ```

  No `--health-cmd`: ayrs has no serve-liveness heartbeat, and unlike the Bun
  daemon (which could freeze its JS event loop while alive → needed the
  healthcheck-restart) the Rust host has no such "alive-but-wedged" failure mode,
  so restart-on-crash suffices. Verified: SIGKILL → oxmgr respawns cleanly, old PID
  reaped (the oxmgr _daemon_ reaps its children), host-lock + room preserved.

  Gotcha: if you kill a _standalone_ (non-oxmgr) ayrs, its parent may be the PID-1
  oxmgr-runtime, which does NOT reap → the process lingers as a `<defunct>` zombie.
  ayrs's two-hosts-in-one-room guard reads `~/.agent-yes/.share-host-<room>.pid` and
  does `kill -0` on it — which returns "alive" for a zombie — so a fresh start then
  falsely refuses with "another ayrs host is already serving." Fix: `rm` the stale
  `.share-host-<room>.pid` and restart. (Under oxmgr this doesn't happen — the
  daemon reaps its own children.)
