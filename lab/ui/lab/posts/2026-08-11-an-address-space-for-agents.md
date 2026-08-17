---
title: An address space for agents — where agent-yes is going
tag: Ambition
summary: The goal is not a better terminal UI. It is an operating layer for a fleet of agents that outlives any one session, machine, or person's attention — an address space, a bus humans are also on, and delegation with accountability.
---

<p class="lede">Everything shipped so far answers "how do I run an agent without watching it."
The next stretch answers a harder question: <b>what does a fleet need in order to be trusted with
real work?</b> Three things, none of which a chat UI can provide — an address space, a shared bus
that humans are on too, and delegation that leaves a record. This is the ambition, stated plainly,
with the parts that are still missing marked as missing.</p>

## Horizon 1 — every agent has an address

Today an agent already has an identity: a stable string of the form
`user@host:path:branch#pid`, stamped into every message it sends. That is the seed of an address
space, and the endgame is the sentence written on the architecture map: _anyone can expose their
own AI agent to the network with a single link, self-contained and end-to-end encrypted._

Two pieces of that exist. Links work, and they are properly end-to-end encrypted: the secret rides
the URL fragment, the relay only ever holds a value derived through HKDF, and frames are sealed
with keys the server has never seen. Scoped tokens work too — `ay callback` mints a capability for
exactly one agent, send-only, with a hard expiry carried _inside_ the signed payload, so revocation
does not depend on server-side bookkeeping surviving.

The piece that does not exist yet is the general case. There is still a master token: one value
that means read every terminal, send to every agent, spawn and kill. Every scoped capability today
is a special case built beside it rather than a slice out of it. The work is to invert that —
**capabilities become primitive, and the master token becomes the degenerate capability that
happens to include everything**, with view / steer / admin as separable grants and identity bound
to something a person actually has (an OAuth account) rather than to possession of a string.

The test for whether this is done is unglamorous and concrete: _can I hand a colleague a link that
lets them watch one agent, in one repo, for two hours, and nothing else?_ Right now the honest
answer is "almost."

## Horizon 2 — a bus that humans are on

The failure mode of agent tooling is that agents get a rich channel to each other and humans get a
scrollback buffer. agent-yes is trying to avoid that by making the _page_ the meeting point rather
than the terminal.

Three primitives are already built and they point the same way. `ay callback` puts a message box on
whatever an agent publishes, so the person reading a report can reply into the agent that wrote it
without finding a terminal. `ay term embed` drops a live read-only terminal into any page, so
"what is it doing right now" is a link rather than an ask. `ay widget` runs the other direction —
an agent reads the selection or DOM of a page a human is looking at, so "this bit here" becomes
addressable. And `ay ch` gives all of them a shared substrate: local-first channels over a WebRTC
mesh, encrypted end to end, where humans and agents are peers on one topic rather than two
populations connected by copy-paste.

What is missing is coherence. These are four good primitives that do not yet feel like one product,
and a person's mental model has to be built from four separate explanations. Consolidating them —
one identity, one permission grant, one place a conversation lives regardless of which surface you
reached it through — is the work that turns a set of features into a bus.

## Horizon 3 — delegation that leaves a record

Once agents spawn agents, the interesting problems stop being technical.

The fleet already nests: children link to parents through an injected environment variable and
render as a forest, so you can see which agent asked for what. Work already outlives the process
doing it — `ay todo` keeps a task store at the repo's common root, shared across worktrees and
agents, and `ay ask` / `ay answer` turn a question into a task with both parties and their
liveness recorded, so a question cannot quietly evaporate when a session ends. Approvals already
have one structural property worth more than any amount of policy text: **the validator cannot be
the owner**, which makes self-approval impossible rather than discouraged.

That is the right direction, and it is early. The ambition is a fleet where you can answer, after
the fact and without trusting anyone's summary: what was this agent asked to do, by whom, what did
it change, who verified it, and what did it hand off. Not because auditability is virtuous, but
because it is the precondition for delegating anything that matters. An agent you cannot
reconstruct is an agent you can only use for work you were willing to lose.

## The consolidation nobody sees but everybody feels

Three things are cluttered, and shipping features on top of clutter has a compounding cost:

- **Three networking stacks that do not share a model** — HTTP, WebRTC + signaling, and a libp2p swarm. The fix is already named: make the swarm _a transport into `apiFetch`_ rather than a parallel universe with its own idea of what an agent is. Then peers become just another reach surface.
- **Two runtimes that drift.** Rust is primary, TypeScript is the reference, and parity is currently defended by a hand-maintained table plus a few tests that parse both sources. That does not scale with surface area.
- **Scattered state and several independent watchdogs.** One state directory and one liveness story, instead of a per-stack defence for each way a native dependency can freeze.

Alongside that: collapse the overlapping serve modes so `ay serve` picks its transports itself, make
the desktop build genuinely self-contained, and wrap the existing console PWA in a thin native shell
so background reconnect and push work like a phone app should.

## The thing that gets harder as this succeeds

Worth stating clearly, because it is the risk that grows fastest.

agent-yes exists to auto-approve. Widening reach — a callback button on a public report, a page
widget an agent can read, a channel a human drops a link into — means untrusted text keeps arriving
at a process whose entire job is to say yes. Prompt injection is not a hypothetical here; it is the
central threat model, and no amount of transport encryption touches it.

The mitigations that exist are structural rather than clever: capabilities are send-only and
single-agent where possible; visitor messages arrive wrapped in an explicit _untrusted_ frame so
provenance is visible in the transcript rather than inferred; inter-agent messages carry attributed
envelopes; injected text is deliberately kept inert against the wrapper's own pattern set, so a
message can never trigger the automation that delivered it. The direction is more of that — **make
where a sentence came from a first-class property of the sentence**, and keep the blast radius of
believing it small.

## What success looks like

Not a bigger console. The measure is whether these become boring:

- Hand someone a link that grants exactly one agent, for exactly as long as you meant, and nothing else.
- Ask a fleet a question and get an answer that survives every process that participated in it.
- Have an agent publish something a person can reply to, in the place they read it.
- Reconstruct, a week later, who asked for a change and who checked it.
- Lose any daemon or console and lose no work.

The last one already holds — it is what the [local fabric](./2026-08-11-no-daemon-owns-your-agents)
buys. The other four are the project, and so is the one not on the list: the fabric is per-machine
files, so losing a _machine_ still loses its agents, its logs and its task store.

<p class="note">Start at the beginning: <a href="./2026-08-11-the-terminal-is-the-api">the terminal
is the API</a> — why one small edit forced all of this.</p>
