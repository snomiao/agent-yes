---
title: A confirm code that goes stale — how slack-term makes agents safe to give a voice
tag: Ecosystem
summary: slack-term is the agent-yes fleet's human-comms surface. Its confirm gate hashes the destination, the actor and the conversation's current last message — so it expires the moment anything that mattered moves. Plus what it gets right, and where it is thinner than its README claims.
---

<p class="lede">An agent that can only read is a curiosity. An agent that can write into the
channel where your colleagues work is either infrastructure or a hazard, and which one it is
comes down to a handful of design decisions. <a
href="https://github.com/snomiao/slack-term">slack-term</a> is the Slack CLI the agent-yes fleet
uses to talk to humans, and it is worth reading for one idea in particular: a confirmation code
that <b>goes stale when the conversation moves</b>.</p>

## Where it sits in the ecosystem

agent-yes gives a fleet of agents an address space — they can be listed, tailed, messaged and
delegated to. But a fleet that can only talk to itself is a closed loop. The parts of the system
that face _humans_ are the ones that decide whether any of it is useful: `ay callback` puts a reply
box on a published report, `ay ch` gives humans and agents one channel, and slack-term takes the
fleet into the place work already happens.

That last one carries a different risk profile from the rest. A callback widget is send-only into a
terminal you own. Posting to `#general` is irreversible, public, and attributed to _you_. So the
interesting engineering is not the Slack API wrapper — it is everything built around the moment of
writing.

## The gate: hash the write, not the intent

Every gated write — `send`, `edit`, `delete`, `upload`, `schedule`, `channel create`, `drafts` —
runs twice. The first run previews and prints a 4-hex code; the second run must present it:

```
$ slack send "#general" "deploying v2 now"
From: @alice (U00000001) — Acme
To:   #general
...preview of the channel's recent messages...
Rerun with --code=3f9c

$ slack send "#general" "deploying v2 now" --code=3f9c
```

The code is not a nonce and there is no server, no session, and no stored state. It is
`sha256(parts.join("\n")).slice(0, 4)` — recomputed from scratch on both runs. What goes into
`parts` is the whole design (`ts/cli.ts:1433`):

```js
const code = safetyCode(channelId, threadTs ?? "", lastText, message, self?.userId ?? "");
```

Read that as a list of things that must not have changed between preview and confirm:

- **`channelId` + `threadTs`** — a code minted for one destination cannot confirm a send to another.
- **`self.userId`** — the acting identity. Preview as one profile, switch, confirm → the code is
  dead. Every gate prints a `From: @handle (Uxxxx) — Workspace` line naming who it will act as, and
  binds that identity into the code, so the label cannot drift from the act.
- **`lastText`** — **the destination's current last message.**

That third one is the good idea. If anyone posts between your preview and your confirm, the code
you were given no longer verifies, and you are shown the conversation again before you can proceed.
It is a time-of-check/time-of-use defense built out of content rather than a clock: **no timestamp,
no expiry, no session — freshness is derived from the thing that would make you change your mind.**
For `edit` and `delete`, the same trick binds the target's _current remote text_, so you cannot
edit-over something that was rewritten while you were reading it.

## Gates block, guards warn

Four heuristics fire around a send, and not one of them can stop it:

|                    |                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **near-duplicate** | character-bigram Dice similarity over normalized text; warns at ≥0.82 against messages already in the thread                                                |
| **unreplied**      | the destination's last message is already yours — you are about to double-post, so it prints a ready-to-paste `slack edit` command for that message instead |
| **self-DM**        | DMing yourself with your own user token delivers but never notifies                                                                                         |
| **mentions**       | `@handle` tokens that could not be resolved will post as plain text and notify nobody                                                                       |

All four are `console.error` and fall through. The only hard stop in the whole path is a missing or
wrong `--code`.

That split is worth stating as a rule, because it is what keeps the system coherent: **irreversible
things get a gate; advisory things get a line on stderr.** Heuristics that can block teach people to
reach for a bypass flag — and the moment a bypass flag exists, it will eventually be used on the
real gate too. Because the fuzzy signals stay advisory, the repo ships **no `--yes`, no `--force`,
no `SKIP_CONFIRM`** at all.

## The honest part: it is a review gate, not an authorization gate

Here is the thing the project is refreshingly clear-eyed about. The gate holds no secret. The
expected code is deterministic, and the CLI prints it straight back to you on a wrong-code retry:

```
Code mismatch (got 0000, expected 3f9c)
Rerun with --code=3f9c
```

Any script can defeat that in two lines — and the repo's own test suite does exactly that, regexing
`--code=([0-9a-f]{4})` out of stderr at roughly 19 call sites. The Rust implementation says so in
its own source: _"Always print the hash so scripts can capture and rerun."_

So the gate is not a permission boundary. It is a **forced-review step**: it makes the default path
one where a human or an agent must look at a rendered preview of exactly what will be posted, where,
and as whom, before anything happens. An agent determined to route around it can. The value is that
nothing does so _by accident_ — and accident, not malice, is what actually posts to the wrong
channel at 3am.

Calling that out is better engineering than pretending otherwise, because a team that believes a
review gate is an authorization gate will eventually put something behind it that needed a real one.

## Display names are attacker-controlled

Anyone in a Slack workspace can set their own display name, and that name gets drawn into your
terminal — inside the confirm preview you are about to make a decision from.
`stripTerminalControls()` (`ts/cli.ts:811`) removes ANSI CSI sequences, all C0/C1 control characters
including a lone ESC, **and Unicode bidi controls** (LRM/RLM, LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI).

Stripping ANSI is common. Remembering that a right-to-left override can visually reorder the line
that is supposed to be telling you what you are about to send is not. Sanitizing _the preview
itself_ follows from taking the gate seriously: a preview that can be made to lie is worse than no
preview, because it is trusted.

The coverage is deliberate but not yet total — it is applied to the sender label and the mention
previews; the gate's own quoted message previews and channel labels still render Slack-controlled
text unstripped.

## A denylist stored as hashes

The repo is public and its test fixtures come from real Slack recordings, so it treats its own
corpus as a leak risk. `.githooks/denylist.sha256` holds ~26 SHA-256 hashes and no plaintext, and
says why in the file:

> Stored as hashes on purpose: this repo is public, so it must not spell out the real names and IDs
> it is protecting.

A plaintext list of the names you are protecting is itself the disclosure. There is a second-order
reason too: plaintext would be rewritten by any future history scrub, silently inverting what the
hook blocks.

Two modes, and the docs are explicit about why both must exist:

| mode    | sees                                   | role                  |
| ------- | -------------------------------------- | --------------------- |
| default | the **staged diff** — added lines only | commit hook           |
| `--all` | **every tracked file**                 | `prepublishOnly` + CI |

The commit hook is _structurally blind_ to data already sitting in the tree: committed once, never
re-added by any later diff, therefore invisible to every future staged scan. That blind spot is not
hypothetical — it is how real workspace data once reached npm, and the whole-tree gate exists
specifically to close it. One scanner, three enforcement points (hook, CI, publish), no
reimplementation per venue.

The placeholder scheme deserves a mention because it is _machine-decidable_ rather than a style
guide. A real Slack ID is a type letter followed by 8+ `[A-Z0-9]` **whose tail mixes letters and
digits**; a `0000` run separately marks an ID as fake. Testing the tail rather than the whole string
is load-bearing: the leading `C` of `C00000001` would otherwise count as "the letter" and make every
placeholder read as real. It scans fixture **filenames** as well as bodies.

## Built so an agent is a good citizen

The affordances that only make sense when the operator is a machine:

- **Reaction-as-ack is deliberately ungated** — "a reaction is trivial and fully reversible, and the
  whole point is a lightweight ack." The cheap polite action stays frictionless while the loud one
  stays gated. 👀 for _seen_, ✅ for _done_, ⏳ for _working on it_ — a thread that does not grow.
- **`--unreplied`** — "only conversations whose last word isn't mine." Whose ball it is, computed
  rather than guessed.
- **`[+N replies]`** — Slack's history endpoint returns thread parents but no replies, so a naive
  renderer hides entire conversations. Marking them means a reader is never misled into thinking it
  has read everything.
- **stdout is data, stderr is commentary** in the streaming path, so `slack tail "#general" | grep
deploy` sees messages and not chrome.
- **Output is valid input** — a printed permalink or ISO stamp can be pasted straight back as a
  target, with strict parsers that throw rather than guess.
- **`SKILL.md` ships in the npm tarball** with agent-skill frontmatter, so it triggers on how a user
  _talks_ ("any mentions?", "DM @person") rather than on the tool's name.

Then there is `ts/todo.ts`, which encodes task state entirely in Slack reactions — 📌 marker,
✅/🚫/👀/⏳ progress, stacking reason flags — with no external store, so humans see the same state in
the Slack UI that the agent queries. Two comments in that file are the best writing in either repo.

The first records a **measured negative result**:

> the obvious alternative — posting a machine-readable token like `todo:v1 blocked-on=@alice` — does
> NOT work: Slack's full-text index splits on punctuation, so a quoted search for "blocked-on"
> returns 0 hits (measured), and "1.91" matches 1.91.0.

The second explains an ordering invariant:

> **ORDER IS THE WHOLE POINT**: `reactions.add` runs FIRST, then removes. Never invert this.
> Removing first leaves a window with zero progress reactions; a crash, a 429 or a Ctrl-C inside
> that window drops the task out of every `todo ls` query permanently, with nothing left to point at
> it.

Add-first's worst case is a message carrying two progress reactions — harmless, _because the
invariant is "at least one, readers collapse by priority" rather than "exactly one."_ Choosing the
weaker invariant is what makes the operation safe to interrupt. Removes are awaited serially because
`Promise.all` would drop the ordering guarantee. That is the same reasoning agent-yes applies to its
own file-based fabric, arrived at independently against a completely different substrate.

## Where it is thinner than it looks

A fair reading has to include these.

**Credentials at rest are unhardened.** `~/.config/slack-cli/profiles.json` holds tokens and session
cookies and is written with `writeFileSync` and no `mode` argument, so it lands at the process umask
— typically world-readable. There is no `chmod` call anywhere in `ts/` or `rs/`. For a project this
careful about every other boundary, this is the odd one out.

**"Verified byte-for-byte" oversells the parity test.** The mechanism is real and well-built —
byte-identical stdout from both runtimes against a mock server, with an isolated `HOME` so no real
profile bleeds in — but it covers **2 of 23 commands** (`news`, `search`), and it _skips silently_
when the Rust binary or the fixtures are absent. A gate that skips by default is not a gate. Worse,
the one thing that most needs to match across implementations — the write gate — is the thing that
matches least: the Rust `send` uses `--confirm` rather than `--code`, binds neither the thread nor
the acting identity, and collapses to `sha256(message)` when its context fetch comes back empty.

The two runtimes are not really peers; one is the product and the other is a frozen subset. Compare
agent-yes, which has the same TS/Rust split and solves it with the opposite polarity: it does not
diff behavior, it _pins the surface_ — a test parses both `ts/subcommands.ts` and `rs/src/cli.rs` as
text and fails when the subcommand lists disagree, and everything else lives in a parity table
allowed to say "not planned." Enforce the surface, negotiate the behavior.

**`SKILL.md` still points agents at a deprecated package.** It says to install `@snomiao/slack`; the
README marks that deprecated in favour of `slack-term`. Of the three, this is the one that actively
misleads, because SKILL.md is the file an agent reads.

## What carries over

Three ideas here are worth stealing regardless of Slack:

1. **Bind your confirmation to the state that would change your mind.** Not a nonce, not a
   timestamp — the destination, the actor, and the conversation's current last message. It goes
   stale exactly when it should.
2. **Gates block, guards warn — and never mix them.** One hard stop, uniformly applied, is
   comprehensible and needs no bypass flag. The moment a fuzzy heuristic can block, someone builds a
   `--force`, and then it is on the real gate too.
3. **Say which one you built.** A forced-review step and an authorization boundary look similar from
   the outside and fail very differently. Naming it correctly is what stops someone putting
   something behind it that needed the other kind.

<p class="note">Related: <a href="./2026-08-11-an-address-space-for-agents">an address space for
agents</a> — why a fleet needs a bus that humans are on too.</p>
