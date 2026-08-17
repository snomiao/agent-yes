---
title: agent-yes lab
summary: Notes on turning AI coding CLIs into addressable, long-running infrastructure — what agent-yes is, what it already does, and where it goes next.
---

# The lab

<p class="lede">agent-yes began as a wrapper that pressed <b>y</b> so an AI coding CLI would stop
waiting on a human. Almost everything since has been a consequence of that one change. This is
where the consequences get written down — design notes, threat models, and the honest status of
a system that is still growing.</p>

## The idea, in one line

An AI coding CLI is a program in a terminal. **agent-yes makes it a process you can address** —
list it, read it, message it, resize it, restart it, hand it to a colleague, and give it a URL.

That sounds like tooling. It is closer to a change of category.

## Why that is not a small difference

Every agent CLI ships with the same assumption baked in: _a human is sitting right here._ It asks
before it edits. It draws a full-screen TUI for eyes that are watching. It dies when the terminal
closes. Those are reasonable defaults, and they are also a ceiling — they cap an agent at exactly
one person's attention, and attention is the scarcest thing in the building.

agent-yes removes the assumption in the least invasive way available: it does not fork the CLIs, it
does not need their APIs, and it does not wait for a vendor to ship a daemon mode. It runs the real
binary in a pseudo-terminal and answers the questions a human would have answered. The terminal
_is_ the integration surface.

What follows is the interesting part. Once one agent no longer needs a human in the loop, each
capability forces the next:

- If nobody has to watch it, it can run overnight → **auto-yes, crash restart, idle exit, stall watchdogs.**
- If nobody is watching, you still need to be able to look → **a raw PTY log per agent, `ay ls`, `ay tail`.**
- If you can look, you will want to look from the sofa → **`ay serve`, a browser console, a PWA.**
- If you can look from anywhere, so can anyone holding the link → **end-to-end encryption, scoped tokens.**
- If you can reach into an agent, agents can reach each other → **`ay send`, attributed message envelopes, an agent forest.**
- If agents delegate to agents, the work needs to outlive them → **`ay todo`, `ay ask` / `ay answer`.**
- If agents talk to agents, humans must stay on the same bus → **`ay ch` channels, `ay callback`, `ay term embed`.**

No step there is a product decision. Each one is the bill for the previous step. The lab exists
because paying those bills honestly is more interesting than the original trick.

## Five planes

The system reads cleanly top-down, and the
[interactive architecture map](https://agent-yes.com/architecture.html) draws the same boxes as a graph:

| Plane                   | What lives there                                                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **① Agent core**        | The PTY wrapper. Spawns any agent CLI, matches ready / enter / fatal patterns, restarts on crash, resumes sessions, propagates terminal size. Rust is the primary binary; TypeScript is the reference implementation. |
| **② Local fabric**      | `pids.jsonl` (every agent, both runtimes), a FIFO per pid for stdin, a raw PTY log per agent for stdout. Files, not a daemon.                                                                                         |
| **③ Exposure**          | One transport-agnostic handler, `apiFetch(req) → Response`. HTTP and the WebRTC bridge are both just callers; port tunnels and libp2p peers fold in next.                                                             |
| **④ Trust & discovery** | Signaling that is a rendezvous only, an HKDF key split so the relay never holds a key, and signed capability tokens that carry their own scope.                                                                       |
| **⑤ Reach surfaces**    | The browser console, the CLI on another box, embeddable widgets, a system tray, peers.                                                                                                                                |

The seam that holds it together is plane ③. Because `Bun.serve` and the WebRTC bridge already call
the _same in-process_ `apiFetch`, a new transport is a new caller and never a new control plane.
That is what turns "three stacks" back into one system.

## What is actually true today

Not a roadmap — the parts you can run right now:

- **The wrapper** works across Claude, Codex, Gemini, Copilot, Cursor, Qwen, Grok, Auggie and more, on macOS, Linux and Windows, from a single Rust binary.
- **No daemon owns anything.** Every `ay <cli>` is its own process in its own session. Kill `ay serve` — or let it crash — and not one agent notices.
- **The fleet is inspectable**: `ay ls` / `ay ps` / `ay tail -f` / `ay hist`, live state per agent (active · idle · needs_input · stuck · stopped), and a process-tree rollup of CPU and memory.
- **The fleet is steerable**: `ay send`, `ay key`, `ay select`, `ay attach`, `ay restart`, `ay stop` — including into an agent you did not start.
- **It is remotely reachable**: `ay serve` for HTTP, `ay serve --share` for an end-to-end-encrypted WebRTC console, `ay expose <port>` for a private URL onto a local port.
- **It is embeddable**: `ay callback` (readers message an agent), `ay term embed` (a live read-only terminal in any page), `ay widget` (an agent reads the page a human is looking at).
- **Agents coordinate**: a parent/child forest, attributed `<ay-msg>` envelopes, a shared task store, and `ay ask` / `ay answer` for questions that must not evaporate when a session ends.

## Where this goes

Short version: **an operating layer for a fleet of agents that outlives any one session, any one
machine, and any one person's attention.** The long version is a post below — it argues for an
address space, a bus that humans are also on, and delegation with accountability, and it is honest
about the four places the current system is still cluttered.

## The ecosystem

agent-yes is the fleet. Around it sit tools that give the fleet somewhere to _reach_ — each a
standalone CLI in its own right, each usable without the others:

|                                                         |                                                                                                                                    |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **[agent-yes](https://github.com/snomiao/agent-yes)**   | run, watch, message and delegate to a fleet of AI coding agents                                                                    |
| **[slack-term](https://github.com/snomiao/slack-term)** | the human-comms surface — read and write Slack from a terminal, with a confirm gate built for operators who are sometimes machines |

The connective tissue is a shared stance rather than a shared library: file-based state over
daemons, one command surface across two runtimes, gates on the irreversible and warnings on the
merely unwise, and a hard rule that no real operational data lands in a public repo. Both projects
arrived at the same interrupt-safety reasoning against completely different substrates — one over
`pids.jsonl` and a FIFO, the other over Slack reactions.

---

## Notes

<!--posts-->
