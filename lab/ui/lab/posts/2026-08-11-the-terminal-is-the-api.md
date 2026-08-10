---
title: The terminal is the API — what agent-yes actually is
tag: Idea
summary: Every agent CLI assumes a human is watching. agent-yes removes that assumption by driving the real binary through a pseudo-terminal — and almost every feature since has been the bill for that one change.
---

<p class="lede">agent-yes is usually described as "a thing that presses y for you." That is
accurate and it undersells the point. Pressing <b>y</b> is not the feature; it is the smallest
possible edit that removes a human from the critical path — and once a human is off the critical
path, a coding agent stops being a session and starts being a process. Everything else in the
project is the consequence.</p>

## The assumption baked into every agent CLI

Claude Code, Codex, Gemini CLI, Copilot, Cursor, Qwen, Grok, Auggie — different vendors, different
models, one shared premise: *a human is sitting right here.*

It shows up in three places. The tool asks permission before it touches anything. It paints a
full-screen TUI sized to the window it happens to be in. And it exits when its terminal goes away.

Those are correct defaults for the demo, and they are a ceiling in production. They bind one agent
to one person's attention, and attention does not scale. You cannot run six agents overnight if all
six stop on the first "Proceed? (y/N)". You cannot check on them from a train. You cannot let one
agent hand work to another, because neither has a mouth or an address.

So the interesting question is not "how do I make the model better." It is: **what is the smallest
change that makes an agent CLI addressable?**

## Why not just use the SDKs

The obvious answer is to skip the CLI and call the vendor's API. It is also the wrong answer, for
reasons that are practical rather than ideological.

There are eight-plus agent CLIs worth running, and they are not interchangeable at the API level.
Each has its own auth story, session format, tool permissions, context management, and rate limits.
Wrapping them at the API layer means eight integrations that break independently — and it means you
can only ever support the tools that decided to ship a usable SDK.

The terminal, by contrast, is the one interface every single one of them has, and the one they are
most conservative about changing. It is a bad abstraction in every way except the ways that matter:
it exists today, it is identical across vendors, and it works for tools that will never ship a
daemon mode.

So agent-yes runs the real binary in a real pseudo-terminal and reads the bytes. Adding a new agent
CLI is not an integration project; it is a block of regexes.

## What the wrapper is actually matching

Each CLI gets an entry in a config file that classifies what its screen currently means:

```yaml
clis:
  someagent:
    promptArg: last-arg
    yesArgs: [--dangerously-skip-permissions]
    enter:            # a prompt to answer — press Enter on it
      - "Do you want to proceed\\?"
      - "Yes, and don't ask again"
    ready:            # parked at a prompt, safe to type
      - '\? for shortcuts'
      - "^>[  ]"
    working:          # busy — do not interrupt
      - esc to interrupt
    needsInput:       # blocked on an interactive selection menu
      - "Select an option"
    fatal:            # unrecoverable — exit rather than loop
      - "authentication failed"
    wedgeTimeoutSecs: 1800
```

The `enter:` list is what actually presses the key. The four *screen states* — `ready`, `working`,
`needsInput`, `fatal` — buy something less obvious and more valuable: **a machine-readable liveness signal for a program that was
never designed to emit one.** `ay ls` can tell you an agent is `needs_input` rather than `active`
because the pattern set says so. That single classification is what later makes notifications,
watchdogs, task automation and the web console possible.

## The failure modes nobody designs for

Driving a TUI from software surfaces problems that never appear when a person is watching, because
a person silently absorbs them.

**Terminals answer questions.** A CLI can emit a cursor-position query and block until something
answers. With a human's terminal emulator on the other end, that is invisible. Put two emulators in
the path — a wrapper and a browser-side xterm — and you can build a feedback loop where each keeps
answering the other, forever.

**Spinners lie.** An agent can sit at 0% CPU with a spinner frame frozen on screen, having lost its
API stream with no error. Nothing is broken enough to exit and nothing is alive enough to progress.

**Some wedges paint nothing at all.** The nastiest observed state matched *none* of the patterns —
not ready, not working, not needs_input — and stayed that way for days at zero CPU. There is no
pattern for "the screen has stopped meaning anything," so the only usable signal is time: total PTY
silence in an unclassifiable state, past a threshold, is a wedge.

Each of these got a watchdog, and each watchdog exists because unattended operation is a different
engineering problem from attended operation. The model is the same. The failure surface is not.

## The chain

Here is the part worth internalising. Almost nothing in agent-yes was chosen from a feature list.
Each capability is the bill for the previous one:

1. **Nobody has to watch it** → so it must survive the night: crash restart, idle exit, stall and wedge watchdogs, retry nudges that are careful not to look like the patterns they trigger on.
2. **Nobody is watching it** → so you must be able to look afterwards: every agent streams raw PTY bytes to a per-agent log, and any other process can render that log without touching the agent.
3. **You want to look from anywhere** → `ay serve` exposes one handler; a browser console renders the same terminal on a phone.
4. **Anyone with the link can look** → so the link must be safe to send: the secret rides the URL fragment, the relay only ever sees a derived token, and traffic is sealed with keys the server has never held.
5. **You can reach in, so agents can reach each other** → messages get attributed envelopes and stable identities; children nest under parents in a forest.
6. **Agents delegate to agents** → work has to outlive the process doing it: a shared task store, questions that become tasks, approvals whose validator cannot be the owner.
7. **Agents talk, humans must not be locked out** → channels, embeddable widgets, callback buttons on the pages an agent publishes.

Read that list backwards and it looks like an ambitious platform. Read it forwards and it is seven
forced moves from one small edit.

## One agent, one URL

The end state the chain points at is stated on the architecture map as a single sentence: *anyone
can expose their own AI agent to the network with a single link, self-contained and end-to-end
encrypted.*

Which means the unit of the system is not the chat, the repo, or the model. It is **the agent** —
a long-lived process with an identity, a log, an inbox, a state, and an address. agent-yes is the
layer that makes that unit real on machines you already own, using CLIs you already installed.

Pressing **y** was just how it got in the door.

<p class="note">Next: <a href="./2026-08-11-no-daemon-owns-your-agents">no daemon owns your
agents</a> — how the local fabric works, and why files beat a supervisor.</p>
