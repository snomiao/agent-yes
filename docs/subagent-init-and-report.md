# `<ay-init-msg>` and the sub-agent reporting duty

Two halves of one loop: a sub-agent must know **who spawned it and how to talk
back**, and the parent must **hear about it** when the sub-agent finishes or gets
stuck — without babysitting a terminal.

## The problem

`ay <cli> -- "<task>"` run from inside another agent's Bash tool detaches and
returns immediately (see `ts/forkNested.ts`), which is what keeps the parent
responsive. But the child received a bare task string. It had no idea it was
spawned by an agent rather than a human, that the agent is waiting on it, or that
`ay send` even exists as a route back. So it did the work, printed a summary
nobody would ever read, and parked at an idle `❯`.

`ay notifyd` already detects `idle` / `needs_input` / `exited` edges — but it is a
**pull** channel: nothing is delivered unless the parent runs `ay notify watch`.
The parent that spawned a fan-out and went back to its own work is exactly the
parent that is _not_ watching.

## Half 1 — `<ay-init-msg>` on the initial prompt

`ay send` wraps every agent→agent message in `<ay-msg nonce from … — reply: ay
send <id> "...">`. The initial prompt now gets the same treatment, plus an
explicit reporting duty:

```
<ay-init-msg 3f9a21c8 from claude #4242 @ ~/ws/repo — reply: ay send agt_p "...">
<ay-task 3f9a21c8>
…the task exactly as the parent wrote it…
</ay-task 3f9a21c8>

The task above was given to you by that agent — it spawned you and returned
immediately, so it is NOT watching your terminal …
  ay send agt_p "..."          report progress, ask a question, deliver the result
  ay tail agt_p                read what it has been doing

Reporting duty — you MUST `ay send agt_p` when either happens:
  1. You finish the task. …
  2. You are blocked or stuck: …
</ay-init-msg 3f9a21c8>
```

Details that matter:

- **Nonce framing, same as `<ay-msg>`.** The nonce is minted _after_ the prompt
  text exists, so a task body cannot forge a matching open/close marker. Nonce
  match — not tag syntax — is what makes the boundary trustworthy, which is why
  the tags are not strict XML.
- **The reply route is the parent's `agent_id`, not its pid.** A pid dies when
  the parent restarts; the `agent_id` survives (see `cmdRestart`'s
  `AGENT_YES_AGENT_ID` injection). The `#pid` stays in the header for humans.
- **Only sub-agents get it.** A top-level agent started from a human shell has
  nobody to report to, and the block would be pure noise on the common path.
- **Only the delivered prompt is wrapped.** The registry keeps the raw task, so
  `ay ls` still shows the one line that identifies the agent's role instead of a
  wall of wrapper boilerplate.
- **The task is wrapped before any ambient decoration.** The SKILL.md header and
  the peer-discovery hint prepend _outside_ the block: they are guidance, not
  part of what the parent asked for.

Implementation: `ts/initMsg.ts` (pure) + `ts/parentLink.ts` (resolve the parent
wrapper pid to an identity), wired in `ts/index.ts`. The Rust runtime mirrors it
in `rs/src/init_msg.rs`, wired in `rs/src/main.rs`. Both assert against the same
fixture, `tests/fixtures/ay-init-msg.golden.txt` — an agent must not be able to
tell which runtime launched it from the shape of its own prompt.

## Half 2 — the wrapper pushes, so a forgetful agent can't strand its parent

The init block asks the _agent_ to report. That is the good path: a considered
message, written by something that actually knows what happened. But an agent
that runs out of context, crashes, or simply forgets is precisely the case the
parent is waiting on — so the **child's wrapper** reports too, unconditionally,
through the same `ay send` channel a peer agent uses:

| edge       | when                                                           |
| ---------- | -------------------------------------------------------------- |
| `finished` | the agent has been continuously idle for 30s (`idleConfirmMs`) |
| `stuck`    | the agent is parked on a question / menu (`needs_input`)       |
| `exited`   | the agent process terminated                                   |

The parent receives an `<ay-report …>` block, explicitly labelled as coming from
the wrapper and not from the agent, carrying the task, the recent tail as
evidence, and the next commands to run.

Design notes:

- **A `working` spinner beats everything.** A 2-minute silent test run classifies
  as `active`, never `finished`. Any unrecognised screen also falls back to
  `active`: a late report costs time, a false "finished" costs correctness.
- **Idle has hysteresis; stuck does not.** A breath between tool calls is not
  "done". A blocked agent has no waiting to earn.
- **A stuck episode never decays into `finished`.** If the question scrolls off
  the tail the episode keeps its identity, so a blocked agent is never reported
  as done.
- **It keeps pinging.** One message can be missed — the parent may be mid-tool-call
  or may have been compacted since. An unresolved episode repeats on an escalating
  backoff (2m → 4m → 8m → 15m, `maxRepeats` 4), labelled `reminder #N`. The whole
  episode resets the moment the child goes active again.
- **`--force` is deliberate.** `ay send`'s recency guard exists to stop an agent
  firing at a target it never looked at; a child reporting to its own parent is
  the one relationship where that guard is pure false positive.
- **It yields to a watching parent.** See the next section.
- **Exit is awaited.** The final report is handed to `ay send` before the wrapper
  process goes away, bounded by `deliverPing`'s own timeout.

Implementation: `ts/parentPing.ts` (pure state machine), `ts/parentPingSend.ts`
(message + delivery), `ts/parentPingLoop.ts` (classifier + poller), wired in
`ts/index.ts`.

## Monitoring vs. pushing — they are not duplicates

A parent harness with a **monitor loop** (Claude Code's Monitor tool, an
`ay ls --watch --json` stream, `ay notify watch`, or a polling `ay status <pid>`)
already sees the child's state — `working | idle | needs_input | stopped` — at
its own cadence, with better fidelity than any injected message and without
anything landing in its composer. When the parent can do that, it should: the
spawn tutorial now lists the monitor route **first**.

So the wrapper's push is a **fallback for the parent that isn't looking**, and it
steps aside when someone is. Before each report, `ts/parentWatching.ts` checks two
independent signals — either is enough:

1. a live `ay notify watch` heartbeat for this parent (the purpose-built watcher
   registry), or
2. this parent tailed/read _this_ child within the read window — the same recency
   ledger `ay send`'s misdelivery guard uses, which is what catches an ad-hoc
   harness loop that just polls `ay tail` / `ay ls`.

The check runs at **send** time, not at edge time: whether the parent is watching
can change in between, and send time is when the answer matters. It **fails
open** — a duplicate report is a minor annoyance; a silently stranded parent is
the bug this exists to fix.

`exited` is the one exception: it is delivered even to a watching parent. It is
terminal, it cannot repeat (so it can never become spam), and it is the edge a
poll can miss entirely — the child's record can be reaped between two polls.

Override with `AGENT_YES_REPORT_PARENT`:

| value            | behaviour                                                              |
| ---------------- | ---------------------------------------------------------------------- |
| `auto` (default) | push only when the parent shows no sign of monitoring; `exited` always |
| `always`         | push every edge, even to a watching parent                             |
| `never`          | never push; the agent's own `ay send` and `ay notify` still work       |

## Relationship to `ay notify`

They are complementary, not redundant. `ay notifyd` is the parent-side **pull**
inbox with a durable cursor, retention, and postmortem reads — the right tool for
an orchestrator that wants to drain many children on its own schedule. The wrapper
ping is child-side **push** into the parent's live stdin, for the parent that
never asked. A parent running `ay notify watch` will see both; the report block is
labelled so the duplicate is obvious rather than confusing.
