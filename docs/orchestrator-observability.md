# Orchestrator observability: `needs_input` + `ay status --wait`

Context: a parent orchestrator fanning out sub-agents (claude-yes / codex-yes)
could not tell, from `ay ls` / `ay status`, whether a sub-agent had **stopped to
ask a question** or had **finished** — both surfaced as `idle` (alive + quiet).
So a sub-agent that popped an `AskUserQuestion`-style menu sat there silently;
the parent only noticed by manually `ay tail`-ing it. Real incident
(2026-06-17): one sub-agent stalled this way 3×, dropping 3 round-trips.

## What shipped (branch `feat/needs-input-state`)

1. **`needsInput` config category** (`default.config.yaml`) — alongside
   ready/working/enter/fatal/autoRetry. Matches the menu cursor on a numbered
   option the agent did **not** auto-resolve (claude `❯ N.`, codex `›/> N.`).
2. **`needs_input` state**, derived at query time by `ay ls` and `ay status`
   from the agent's rendered screen (`ts/needsInput.ts`). Distinct from `idle`
   (done/quiet) and `stopped` (exited). `ay status --json` adds a `question`
   field with the pending menu text.
3. **`ay status <pid> --wait`** — blocks until the agent needs attention
   (`needs_input | idle | stopped`), then emits the snapshot. The orchestrator
   primitive: it returns on a blocking question, not just on "done".
   `--watch` already streams state changes, so `needs_input` flows there for free.

## What shipped next (branch `feat/state-events`)

4. **`ay ls --watch`** — a single NDJSON event stream of state transitions
   across _every_ matched agent, so a fan-out parent watches **one** process
   instead of spawning N per-pid `ay status <pid> --watch`es. Each line is one
   transition: `{ts, pid, cli, cwd, state, question, prev_state}`. The first
   time an agent is seen it emits a baseline line (`prev_state: null`); after
   that only genuine `state`/`question` changes emit. An agent reaped between
   ticks gets a synthetic `stopped` line so a "done" transition is never
   dropped. Honours the same keyword/`--cwd` filter as `ay ls`, so a parent can
   scope the stream to just its own batch. The transition-diff core
   (`ts/lsWatch.ts`, `diffLsStates`) is pure + unit-tested; the poll/timer lives
   in `cmdLs` and mirrors `ay status --watch` (poll at `--interval`, run until
   Ctrl-C). Reuses `deriveLiveState`, so the per-agent shape matches what
   `ay ls --json` already reports — consumers parse one schema. Backward-compat:
   a new flag only; `ay ls` with no `--watch` is byte-for-byte unchanged.

5. **`ay result` — structured completion envelope.** A fan-out parent pulls a
   sub-agent's outcome (branch, commit SHAs, changed files, status, blockers,
   summary) as machine-readable JSON instead of grepping `ay tail` — the
   agent-yes analog of an in-harness Agent tool's `<result>` block. Two verbs:
   the sub-agent runs `ay result set '<json>'` (or pipes JSON / plain text) to
   deposit its envelope; the parent runs `ay result <keyword>` to pull it.
   `--wait` blocks until the envelope lands. Keyed by the wrapper pid the agent
   already knows via the injected `AGENT_YES_PID`, so depositing needs **no**
   spawn-time wiring in either runtime. Stored to
   `$AGENT_YES_HOME/results/<pid>.json` (`ts/resultEnvelope.ts` is the pure,
   unit-tested core: path math + input normalization). Read-side exit codes let
   an orchestrator branch without parsing: `0` envelope found, `1` agent stopped
   without one (done, no result), `2` no envelope yet / `--wait` timed out.

## Design decisions — what, why, and what was deliberately NOT done

The parent's brief proposed (P1) adding `needs_input` to a persisted STATUS enum
and (P2) a notify-file callback. After reading the code I chose a different,
smaller shape and **inverted both assumptions** — justification below.

- **`needs_input` is a query-time _derived_ state, not a persisted enum.**
  agent-yes already computes the display status (`active`/`idle`/`stopped`) at
  query time from `is-alive` + log mtime; nothing persists a live state machine.
  `ay status`/`ay ls` _already render the agent's screen_ (for the activity and
  task-badge columns), so classifying `needs_input` from that same render is
  essentially free and required **no run-loop changes, no new write path, and no
  schema change** to the shared `pids.jsonl`.
  - _Rejected:_ writing `needs_input` into `pids.jsonl` from the runtime. It
    would churn the shared append-only index, require new live-transition write
    paths in **both** runtimes, and risk stale state if a runtime is killed
    mid-prompt. The query-time derivation can't go stale (it reflects the screen
    right now) and is computed only when someone actually asks.

- **Detection is runtime-agnostic — so it is also dual-runtime "parity" for
  free.** The signal is the _drawn menu_, which looks identical whether the agent
  ran under the Rust (default) or TS runtime. One classifier in the TS query
  layer (`ay ls`/`ay status` are TS regardless of runtime) covers both. No Rust
  code changed; the Rust config simply ignores the new YAML field
  (verified: `rs` config tests green).

- **Reused `--watch` as the event stream instead of a new callback channel.**
  `ay status --watch` already emits JSON on every state change. Once
  `needs_input` is a state, it flows through `--watch` automatically — the
  parent gets the transition as an event with zero new IPC.
  - _Rejected:_ a notify-file / unix-socket callback. It is redundant with the
    existing `--watch`/`--wait` polling stream, adds a new IPC surface to
    maintain and secure, and the harness model the brief copied (in-process
    callbacks) doesn't map cleanly onto agent-yes's file-based, multi-process,
    cross-host design. Polling at a 0.5–2s interval is more than adequate for a
    human-in-the-loop question and composes with the existing `ay ls`.

- **The detection seam is "a selection menu the auto-responder declined."**
  agent-yes already auto-`enter`s the affirmative option of Yes/trust/dark-mode
  prompts. What is _left_ on a stable screen is exactly the genuine question
  (an `AskUserQuestion`, or a non-affirmative permission menu). So `needsInput`
  doesn't need to understand questions — it keys off the menu cursor that the
  `enter` patterns intentionally did not consume. `working` always wins (a
  spinner means real work, not a block).

- **Backward compatibility was the top constraint.** No existing state value or
  flag changed meaning. `needs_input` only _renames a case previously conflated
  with idle_. `--wait-idle` is byte-for-byte unchanged (its help now points at
  `--wait`). Old `pids.jsonl` records, old config files, and both runtimes are
  unaffected.

Scope was cut to the single coherent abstraction — **make `needs_input` a
first-class observable state** — because that one change removes the root cause
(an unobservable transition) and everything else (wait, watch, result, locks)
either already exists or builds cleanly on top of it later.

## Not done — drafted for later

Each left out with a one-line reason; none is required to fix the reported pain.

- **Global watch stream — `ay ls --watch`.** ✅ Shipped (branch
  `feat/state-events`) — see "What shipped next" above.
- **Join-wait — `ay ls --wait` (block until the whole batch is settled).** The
  blocking counterpart to `ay ls --watch`: exit once _every_ matched agent is in
  a terminal-for-the-operator state (`needs_input | idle | stopped`), so a
  fan-out parent can `ay ls <scope> --wait` and get control back the moment the
  batch collectively needs it. _Why not now:_ `--watch` already delivers the
  events; the parent can implement the join itself by consuming the stream. This
  overlaps with P5 (`ay wait --until`) and is best designed together with it
  (target-state set + multi-pid in one flag) rather than bolted onto `ls`.
- **[P3] `--on-question` mode.** Let a spawn opt into auto-answering or
  auto-routing menus (e.g. always pick a default, or forward the question to the
  parent over a channel). _Why not now:_ needs a policy model + a safe default;
  observing the block first (shipped) is the prerequisite.
- **[P4] Structured result envelope + `ay result <keyword>`.** ✅ Shipped (branch
  `feat/state-events`) — see "What shipped next" #5 above. Key design calls:
  - **Persisted file, NOT a query-time screen scrape.** `needs_input`/activity
    derive from the live screen because they describe _now_. A completion record
    is the opposite: it is read AFTER the agent is done — exactly when its screen
    is gone and its log may be reaped. It must outlive the process, so it is a
    persisted artifact (`results/<pid>.json`) written once and read verbatim.
    This is a deliberate inversion of the needs_input philosophy, justified by
    the different lifetime of the data.
  - **Explicit deposit (`ay result set`), NOT a sentinel scraped from `ay tail`.**
    Scraping a fenced JSON block out of the xterm-rendered log is fragile: the
    PTY reflows long lines at terminal width, so SHAs/paths in a wrapped envelope
    would corrupt. An explicit write keeps the JSON byte-exact. It also composes:
    the agent emits structured data the moment it knows it, not whenever a poller
    next renders the screen.
  - **Keyed by the existing `AGENT_YES_PID`, so zero spawn-time changes.** Both
    runtimes already inject it; the agent self-identifies. No Rust change, no new
    env var, no `pids.jsonl` schema change — purely additive TS subcommand + a
    new `results/` dir. Fully backward compatible.
  - **Read-side exit codes encode the three states** (found / stopped-without /
    pending) so an orchestrator branches on `$?` without parsing JSON; `--wait`
    turns it into the "await the sub-agent's result" primitive.
  - _Deliberately NOT done:_ inlining the envelope into `ay ls --watch` events.
    Keeping the watch stream a lightweight transition log and the envelope a
    pull-on-demand artifact avoids bloating every event with a (usually absent)
    result and keeps the watch schema byte-for-byte unchanged. A consumer that
    sees a `stopped` transition simply pulls `ay result <pid>` for the payload.
- **[P5] `ay wait --until=<state,...>`.** Generalize `--wait` to arbitrary
  target-state sets and multiple pids at once. _Why not now:_ `--wait` covers the
  common "needs me" case; generalize once real call-sites demand it.
- **[P6] Stall heartbeat.** Detect an agent that is neither working nor at a
  known prompt for N minutes (hung, not blocked-on-question) and surface a
  `stalled` state. _Why not now:_ needs a separate liveness signal beyond mtime;
  distinct problem from `needs_input`.
- **[P7] `--lock` advisory.** An advisory per-cwd / per-submodule lock so two
  fan-out tasks don't edit the same working tree concurrently (today the parent
  hand-bundles them). _Why not now:_ there is already a `runningLock`; extending
  it to advisory cross-task locks is its own design.
- **Native runtime detection.** The runtime (which already pattern-matches the
  screen every tick) could push a `needs_input` event the instant a menu appears,
  rather than the query layer noticing it on the next `ay ls`/`--watch` poll.
  _Why not now:_ query-time detection already works and is runtime-agnostic; a
  runtime push is a latency optimization, not a capability gap.
