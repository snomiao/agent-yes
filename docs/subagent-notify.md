# Subagent → parent notifications: `ay notify` + `ay notifyd`

Context (real incident, 2026-07): a parent agent fanned out sub-agents that
committed their work but then **sat at an idle `❯` prompt without exiting**
(`claude-yes` does not exit on idle by default). Claude Code's built-in
background-task notification only fires on process **EXIT** — so the parent
never learned the children went idle and left two of them parked **16 minutes**.
The stop-gap was Monitor-on-HEAD polling, which catches a *commit* but is blind
to a child that finished **without** committing (an investigation, a failure, a
question).

`ay ls --watch` already streams state transitions — but it is **pull**: the
parent must run the watch loop. The whole point of this pain is that the parent
is **not** watching. This feature adds a **push** layer on top of the existing
`needs_input` / `deriveLiveState` / `ay ls --watch` machinery: qualifying edges
accumulate in a per-parent **append-only inbox** the parent drains on its own
schedule, with a persisted cursor so a restarted parent reads only unread edges.

## What a parent runs

One command in its Monitor loop:

```bash
ay notify watch --unread          # tail my inbox; ensures the daemon is up
```

It streams, for every child this agent spawned, three edges — each with a
payload so the parent can act without tailing:

- **`needs_input`** — the child is blocked on a question (the compact question
  text is included). Highest priority: the task is stuck until answered.
- **`idle`** — the child has been **continuously idle** for the confirm window
  (default 30s): hands-free / probably done. Catches the "finished without
  committing" case HEAD-polling can't see.
- **`exited`** — the child process ended (the inverse of today's EXIT-only
  signal).

Other verbs:

```bash
ay notify read [--parent <pid>] [--since <seq>] [--unread] [--ack] [--json]
ay notify cursor get|set <seq> [--parent <pid>] [--consumer <name>]
ay notifyd run|start|status|stop
```

`--parent` defaults to `$AGENT_YES_PID` — the agent's own wrapper pid — so a
parent addresses its own inbox with no argument.

## Design decisions (frozen with codex + the two agents who hit the pain)

- **Detection lives in the query layer, not the run loop (Option 2).** A single
  host daemon (`ay notifyd`) polls `deriveLiveState` across all agents and runs
  the pure debounce router. Rust is the default runtime and `needs_input` is only
  classified in the TS query layer, so pushing detection into the child run loop
  would either miss Rust children or duplicate the hardest classifier in both
  runtimes — the wrong ownership boundary. The query layer is runtime-agnostic,
  so one implementation covers both. _Rejected:_ child-supervisor push.

- **The load-bearing idle guard: `idle` is a `deriveLiveState` state, not a bare
  no-output timer.** `idle` already means "idle prompt visible AND no working
  spinner", so a long, silent tool call (a 2-minute test run) is classified
  `active` and never produces a false idle edge. Without this the feature would
  be a notification storm and get switched off. The router emits an idle edge
  only after the state has been **continuously** idle for `idleConfirmMs`, once
  per idle episode (edge, not level).

- **Edge, not level, with per-episode debounce.** `needs_input` fires on entry
  and re-fires only when the **compact** (chrome-stripped) question changes — a
  spinner/elapsed-seconds cosmetic redraw does not double-fire. `exited` fires
  once. `idle` fires once per idle episode; returning to work resets it.

- **Consumer-side opt-in via a watcher registry — nothing happens unless a parent
  watches.** `ay notify watch` writes a **heartbeat** (`notify/watchers/<pid>.json`,
  refreshed every poll, TTL 15s) and the daemon:
  - **scopes** its work to children whose parent has a live heartbeat — where
    "live" means the heartbeat is fresh AND the watcher process is actually alive
    (a crashed `watch` whose heartbeat lingers for the TTL does NOT keep the
    daemon writing to a dead parent's inbox) — so an unrelated agent that never
    watches gets **no inbox** (the scope matches the "nothing happens unless you
    watch" promise). The daemon takes the parent's `started_at` from the watcher's
    own heartbeat (authoritative, never 0), not a registry lookup that could miss;
  - **stays alive** while any heartbeat is live, self-exiting only after a grace
    window with none.

  `ay notify watch` also **re-ensures the daemon every poll**, so a parent that
  watches BEFORE spawning children (or across a fan-out gap where the daemon
  self-exited) always has a running, correctly-scoped daemon. If no parent ever
  watches, the daemon never runs and **no files are created** — fully backward
  compatible. Monitor-on-HEAD keeps working, now strictly dominated by this.

- **Singleton lock with liveness-based steal; ownership proven only by mkdir.**
  The daemon holds an mkdir lock whose `owner.json` records `{pid, started_at,
  ts}`. A stale lock (owner pid dead / torn) is **stolen** — but the steal only
  removes the dir; ownership is then re-proven by the next `mkdir(recursive:false)`
  (the atomic, exclusive create), so two would-be stealers can never both enter.
  A lock held by a **live** owner is respected. The parent `notify/` dir is
  created first so a clean install can't misread `ENOENT` as "held".

- **`owner.json` is the single source of truth for `status`/`stop`.** A running
  daemon refreshes `ts` every tick; `notifyd status`/`stop` trust the owner pid
  only if it's alive AND its heartbeat is fresh — so a recycled pid (not
  refreshing this file) is never trusted or sent a wrong `SIGTERM`.

- **pid-reuse guards on BOTH read and reconcile.** Every event stamps
  `parent_started_at` and `child_started_at`. The reader drops events whose
  `parent_started_at` disagrees with its own record. The daemon's startup
  reconcile seeds a child's emitted-edge memory ONLY if that pid is still in the
  registry with the SAME `child_started_at` — so a new child recycling a pid never
  inherits the old child's `exitedEmitted`/`idleEmitted` (which would suppress its
  first notification).

- **GC read+compute+write all under the inbox lock.** Rotation reads the inbox,
  computes the keep-set, and rewrites — all inside the same lock `appendEvent`
  takes, so a concurrent append can't be lost between a stale read and the write.
  And it never evicts an event above the **minimum consumer cursor** (unacked) —
  only already-acked events are trimmed.

- **The per-inbox lock steals on HOLDER LIVENESS, not wait time.** The lock dir
  carries an `owner` file (`{pid, ts}`); a contender steals only when the holder
  is dead or its heartbeat is stale — never merely because it waited a while, so
  a live holder mid-critical-section (a big GC rewrite, a slow disk) is never
  robbed into a seq-duplicating double-entry. A torn/empty owner (the
  mkdir→writeFile window of a holder mid-acquire) is respected for a short grace,
  so a just-created lock can't be stolen out from under its creator.

- **`appendEvent` trusts the sidecar seq counter.** The counter is written under
  the lock on every append and stays valid across a GC rewrite, so the hot path
  is O(1) (no full inbox parse) — a full scan only self-heals a missing/corrupt
  counter. This keeps the lock-hold window tiny.

- **The pid-reuse guard survives a synthetic exited.** BOTH the child's and the
  parent's `started_at` are carried in the router's per-child state, so a
  synthetic `exited` for a vanished/reaped child still stamps `child_started_at`
  AND `parent_started_at` (never 0, which would bypass the reader's parent guard).
  Reconcile seeds a child only on a positive identity match (missing/zero start →
  don't seed → allow a re-emit rather than risk suppressing a recycled pid's edge).

- **Hot-path pid-reuse guard.** `stepRouter` applies the same identity check
  per-tick: if an observed pid's start time differs from the tracked one, the old
  child is closed out with a synthetic `exited` and the new child rebuilds fresh
  state — so a recycled pid mid-run doesn't inherit the old child's emitted-edge
  memory and get its first edge suppressed.

- **The lock heartbeats while held.** The lock owner's `ts` is refreshed on a
  timer for the whole time the lock is held, so a long critical section (a big GC
  rewrite) never crosses `staleMs` and gets stolen out from under a live holder.
  The daemon singleton lock shares the same torn-owner grace, so two concurrent
  daemon starts can't both win.

- **Residual (documented): `stop` identity vs OS start time.** `status`/`stop`
  compare our recorded `started_at`, not the OS's real process start time (non-
  portable to read), so a pid recycled onto an unrelated process within the tight
  `OWNER_TTL` window could be briefly trusted. Heartbeat freshness + a few-tick
  TTL bound it to seconds; a real OS start-time cross-check is deferred.

- **`notifyd stop` re-verifies identity before signalling.** It re-reads the
  owner (`pid` + `started_at`) immediately before `SIGTERM`, so a pid recycled
  between the status read and the kill is never signalled.

- **Enrichment is concurrent.** A burst of N edges enriches (tail + git head) in
  parallel; only the inbox appends stay serial (for unambiguous seq allocation),
  so N git timeouts don't serialize.

- **Append-only inbox + monotonic seq + separate cursor.** Each parent has
  `notify/inbox/<host>/<parent>.ndjson`; every event carries a per-inbox `seq`
  (the authoritative watermark; `ts` is display-only, since clocks skew). A
  consumer's cursor lives in a separate file
  (`notify/cursors/<host>/<parent>/<consumer>.json`) so it survives parent
  restarts. `--unread` reads `seq > cursor`.

- **At-least-once by default; ack is monotonic.** `ay notify watch` does **not**
  advance the cursor unless you pass `--ack` (or use `ay notify read --ack`). A
  consumer that crashes mid-handling (a Monitor torn down at session end) re-reads
  the edge on restart instead of dropping it. When `--ack` IS set, the cursor
  advances to the high-water of what was shown and **never regresses** — an empty
  poll doesn't lower it — so a restarted `watch --ack` resumes past what it
  already delivered, not from a stale cursor.

- **Startup reconcile.** On start the daemon seeds the router's memory from each
  inbox's already-written edges, so a restart does not re-emit a baseline the
  parent already saw — while still emitting the current terminal state
  (`needs_input`/`idle`/`exited`) for a child that was already parked when the
  daemon came up.

- **pid-reuse & cross-host safety.** Inboxes are namespaced by host; events carry
  the child pid/wrapper. (Cross-host *delivery* is out of scope — the daemon only
  sees the local registry.)

- **Retention.** GC deletes an inbox (+ counter + cursors) once its parent is
  dead and no live child references it; oversized live inboxes rotate to the
  newest events.

## Module layout

- `ts/notifyRouter.ts` — **pure** debounce/edge state machine (`stepRouter`).
  The heart; unit-tested (`notifyRouter.spec.ts`), incl. the P1 idle-prompt
  regression fixture.
- `ts/notifyInbox.ts` — **pure** path math + NDJSON (de)serialization + seq /
  cursor / retention helpers (`notifyInbox.spec.ts`).
- `ts/notifyStore.ts` — fs side: locked append, inbox/cursor read-write, GC.
- `ts/notifyDaemon.ts` — the poll loop, startup reconcile, payload enrichment
  (tail + git head), daemon lifecycle.
- `ts/subcommands.ts` — `ay notify` / `ay notifyd` CLI.

## Not done — drafted for later

- **Producer-side `--notify-parent` / `--no-notify-parent` spawn flag** for
  per-child suppression or force-on. Not needed for v1: the daemon-not-running
  default already IS opt-in, and plumbing a flag through both runtimes' spawn
  paths is a separate change. Reconciles the earlier `ay spawn-notify` idea.
- **`stuck` edge.** A wedged child (alive, busy marker, long-silent) is a
  distinct signal from idle; surface it once the `stuck` state is load-bearing.
- **Cross-host fan-in.** Deliver a remote child's edge to a parent on another
  host. Needs the remote-notify transport designed first.
- **Native runtime push.** The runtime could push an edge the instant a menu
  appears instead of the daemon noticing on the next poll — a latency
  optimization, not a capability gap.
