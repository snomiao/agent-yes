---
title: No daemon owns your agents — the local fabric in detail
tag: Architecture
summary: agent-yes has no supervisor process. Agents coordinate through three files, which is why killing the web console, the daemon, or the wrapper never takes a running agent down with it.
---

<p class="lede">The most consequential design decision in agent-yes is a negative one: <b>nothing
owns the agents.</b> There is no supervisor, no broker, no single process whose death takes the
fleet with it. Coordination happens through files. This post is the detailed version of what that
buys, what it costs, and what the whole implemented surface looks like today.</p>

## The shape

Every `ay <cli>` invocation is a standalone wrapper process. It spawns exactly one agent CLI into
its own pseudo-terminal, inside its own session and process group (`setsid`). Two independent runs
share no parent. Nothing sits above them.

That means the web console, `ay serve`, is a **stateless observer**. It reads a file to discover
agents, tails files to render them, and writes a pipe to talk to them. Restart it, upgrade it,
crash it, kill it with `SIGKILL` — no agent is disturbed, because every agent runs in its own
session. Even the ones the console itself spawns are detached at birth, so none of them is ever
in `ay serve`'s session or process group.

The comparison worth making is with the obvious design: a daemon that spawns and supervises
everything. That design is easier to write and gives you an in-memory registry for free. It also
means every bug in the supervisor is a fleet-wide outage, and every upgrade is a decision about
whether to drop running work. Files avoid that entirely, at the cost of having to be careful about
concurrency — a trade covered at the end of this post.

## Three files

**① The registry — `~/.agent-yes/pids.jsonl`.** Every wrapper appends a record: pid, cli, cwd,
`wrapper_pid`, `parent_pid`, `agent_id`, fifo path, log paths, status. Readers merge by pid, last
record wins. `ay ls`, `ay status` and the browser console discover the fleet purely by reading
this file — they need no relationship whatsoever to the processes they are describing.

**② Input — a FIFO per pid at `~/.agent-yes/fifo/<pid>.stdin`** (a named pipe on Windows).
`ay send`, `ay key`, `ay stop` and `ay exit` write here; the wrapper's reader thread forwards the
bytes into the agent's stdin. It is opened read-write so an external writer closing the pipe never
looks like EOF. This is the mechanism that lets one process drive an agent it does not own, without
stealing the keyboard from whoever is attached.

**③ Output — a raw PTY log per agent at `<cwd>/.agent-yes/<pid>.raw.log`.** The wrapper appends raw
bytes as they stream. The log lives next to the work, not in a global directory, so logs follow the
repo and get gitignored automatically. Any other process can tail it, replay it through a headless
terminal emulator, and reconstruct the exact screen — which is how `ay tail` renders an agent it
has no connection to, and how liveness is classified without polling the process at all.

There is a fourth, smaller file that matters more than its size suggests: **`~/.agent-yes/reaper.jsonl`.**
Each wrapper records `(wrapper_pid, agent_pgid)` before it runs, and sweeps the registry on every
startup. If a wrapper died in a way that gave it no chance to clean up — `SIGKILL`, OOM, a power
cut — the _next_ agent to start kills its orphaned process group. Recovery does not depend on the
thing that crashed being alive to notice.

## What you can do with it

The fabric is not an implementation detail; it is the reason the command surface is as wide as it
is. Everything below is live today, from any terminal, against agents started by anyone:

|                |                                                                                                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Inspect**    | `ay ls` (fleet, with the parent/child forest), `ay ps` (CPU + RSS rolled up over each agent's whole process tree), `ay status`, `ay whoami`                                                                      |
| **Read**       | `ay tail -f`, `ay read` (paginated), `ay cat`, `ay head`, `ay hist` (past conversations, including exited sessions)                                                                                              |
| **Steer**      | `ay send`, `ay key` (raw keystrokes — drives menus), `ay select` (pick option N of a blocked menu), `ay attach`, `ay restart`, `ay stop`, `ay exit`                                                              |
| **Coordinate** | `ay todo` (a task store shared across agents), `ay ask` / `ay answer` (a question becomes a task, with the asker and answerer both recorded), `ay msgs`, `ay result`                                             |
| **Reach**      | `ay serve` (HTTP + browser console), `ay serve --share` (E2E-encrypted WebRTC), `ay expose <port>` (a private URL onto a local port), `ay remote`, `ay schedule`                                                 |
| **Embed**      | `ay callback` (readers message one agent), `ay term embed` (a live read-only terminal in any page), `ay widget` (an agent reads the page a human is looking at), `ay mint` (scoped, short-TTL capability tokens) |
| **Provision**  | `ay ws` (clone or refresh `<owner>/<repo>/tree/<branch>` workspaces), `ay setup`, `ay reap`                                                                                                                      |

The pattern repeats: each of those is a small program over the same three files, which is why they
compose. Looping the pids from `ay ls --json` into a per-pid `ay tail` is a fleet dashboard.
`ay ls --watch` is a single
NDJSON stream of state changes across every matched agent — one watcher for an entire fan-out,
rather than N pollers.

## Two runtimes, one contract

agent-yes ships twice: a Rust binary (the primary distribution — single file, fast start, native
PTY) and a TypeScript implementation (the reference, and the fallback). Both are real; both are
used in the same fleet at the same time.

They interoperate because **the contract is the file format, not an RPC**. A Rust-spawned agent
appears in the same `pids.jsonl`, writes the same raw log, and listens on the same FIFO, so a
TypeScript `ay send` drives it without either side knowing which runtime the other is. Adding a
transport, a subcommand or a surface means agreeing on bytes on disk, not on a shared library.

The cost is drift: two implementations of the same behaviour will diverge unless something forces
them together. Some of that is handled by tests that parse both sources and assert they agree —
the subcommand list, for instance, is a hardcoded array in each runtime, and it had silently
drifted by six entries before a mirror test started failing on it.

## The seam that keeps transports cheap

Above the fabric there is exactly one handler:

```
apiFetch(req: Request) → Response
```

`ay serve`'s HTTP listener calls it. The WebRTC bridge calls it in-process. Neither is a control
plane; they are pipes into the same function. (The port-exposure tunnel sits on the other side of
that line — it is _started_ through the handler, by `POST /api/expose`, and then proxies raw bytes
to a local port. A consumer, not a caller.) Adding a
transport — a relay, a peer mesh, something not invented yet — means writing a caller, not a second
system with its own notion of what an agent is.

This is why a share link and a LAN URL and a localhost port all produce an identical console: they
are the same handler reached two ways.

## Where files are hard

Honesty is the point of a lab, so: file-based coordination has real edges, and most of the sharp
ones have already drawn blood.

**Concurrent appends interleave.** A pipe only guarantees atomicity below `PIPE_BUF`. Two agents
writing a large message to the same FIFO at the same moment produced _byte-level_ interleaving —
one logical message arriving in dozens of fragments, mixed with another's. The fix is an advisory
lock around IPC writes, and the guarantee it provides is worth stating precisely: **messages do not
interleave; they are not ordered.** Anything that needs ordering has to say so itself.

**Rewrites clobber appends.** The registry gained a truncate-and-rewrite path, which raced with
concurrent appends and made the console show fewer agents than existed. It now uses a directory
lock both runtimes honour.

**Fire-and-forget is unordered.** Per-keystroke delivery from the browser was three independent
unordered paths, so typing could arrive scrambled — no characters lost, only reordered, which is
the signature of concurrent writes rather than a dropped-input bug. Serialising the send was the
fix; debouncing would only have hidden it.

**State is scattered.** There are more directories under `~/.agent-yes/` than there should be, and
liveness is currently defended by several independent watchdogs instead of one story. Collapsing
those is on the list, not done.

None of these argue for a supervisor. They argue that "no central owner" moves the difficulty from
_availability_ to _concurrency_ — and concurrency bugs, unlike outages, can be fixed once and stay
fixed.

<p class="note">Next: <a href="./2026-08-11-an-address-space-for-agents">an address space for
agents</a> — what this is all being built toward.</p>
