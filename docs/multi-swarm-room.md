# One URL for several swarms ("room of machines") — design note

Status: research note, no implementation. Compares five ways to give an
operator ONE `agent-yes.com` URL that opens a console showing every agent on
several machines, "like an IPFS folder": a room that lists its member machines,
each still reached peer-to-peer.

## The ask

Today each machine has its own share URL (`https://agent-yes.com/w/#<room>:e1.<secret>`),
one star room per host. An operator with two machines opens two URLs. The CLI
side already federates (`ay connect` saves another machine as a remote and
`ay ls` lists its agents from a cached snapshot), the web console does not: it
only shows several machines because it remembers every room this browser ever
opened (`localStorage` key `ay.rooms`) and rejoins them all. That is per-browser
state, not a URL anyone can hand to someone else.

## What exists (facts from the code)

| Piece | Where | What it gives |
|---|---|---|
| Star room | `ts/share.ts`, `rs/src/serve/share.rs`, `lab/ui/rtc.js` | One host per room. Console hash `#<room>:e1.<secret>[@sighost]`; `ay connect <url>` saves it as a remote. Both hosts refuse a second host on the same machine; the CLI viewer and the browser answer only the first offer. |
| Signaling worker | `lab/ui/cf/worker.ts` | One Durable Object per room name. The token and the mode (star / mesh) are pinned on first open. `toHost` already fans a client's frames to EVERY authed host socket, so N hosts in one star room is a small change on the server side, not a redesign. |
| Mesh room (`ay ch`) | `ts/channels/*` | Symmetric rooms with a roster: every peer sees `peer-join` for every other peer. Room name is derived from the shared secret (`room = "c" + sha256("ay/ch/room\n" + S)[:12]`), i.e. content-addressed: whoever holds S computes the same rendezvous name. |
| codehost room | `lab/ui/index.html` ("codehost rooms: a THIRD wire"), `room-client.js`, `snomiao/codehost` | One room per token holds N machines. Each machine runs `codehost serve`, advertises its live agents and proxies its local `ay serve` API over its own WebRTC tunnel. The console lists each machine as a source `<room>/<peerId>` and groups the tree by machine. Joined via `ch:<token>` or a `…#t=<token>` link. STUN-only; token is a bearer secret (12+ chars). |
| CLI federation | `ts/subcommands.ts` (`ay ls` with remotes, PR #507) | A machine lists its remotes' agents from per-alias snapshots, refreshed in the background; `--waitFor` forces a live fetch. Not exposed over `/api/ls`, so the console cannot see it. |
| libp2p swarm | `rs/src/swarm/*`, `--features swarm` | Experimental: mDNS + Kademlia + gossipsub topic, `ay://<topic>?peer=<multiaddr>`. No browser transport, no console integration. |

Two cross-cutting facts: a browser or CLI viewer on another network needs a
relay when the host sits behind a symmetric NAT (TURN; PR #509 brings it to the
Rust host), and the console already renders a `room > machine > agent` tree
(`layeredRows` in `lab/ui/console-logic.js`), so any option that yields several
machine sources renders correctly today.

## Options

### 1. Room list in the URL fragment — `#<room1>:<s1>,<room2>:<s2>`

Console-only: parse a comma list and call the existing `addRoomSource` once per
entry. Nothing changes on hosts or the worker.

- One URL: yes, but it is a bundle of secrets, and it grows with every machine.
- Keys: anyone holding the URL holds every member's secret; no way to revoke one member without rotating all.
- Adding a machine later: new URL; everyone has to re-open.
- Offline member: that source shows offline, the rest work (already how multi-room works).
- Effort: about a day. Good stopgap, not the destination.

### 2. One hosted room, N hosts — `ay share --room <link>` (recommended)

Make the star room multi-host. Each machine joins the SAME room as a host with
the same secret; the viewer keeps one peer connection per host and shows each
host as a source `<room>/<hostId>`, exactly the shape the codehost wire already
produces. The URL stays the existing `#<room>:e1.<secret>` form.

- One URL: yes, and it never changes.
- Keys: one shared secret per room; same trust model as a share link today (link = read + steer). Per-member revocation is not possible without rotating, same as now.
- Adding a machine later: run `ay share --room '<link>'` (or `ay serve install --webrtc '<link>'`) on it; it appears in every open console within seconds (`peer-join`).
- Offline member: its source drops out of the roster; the others are unaffected.
- Content addressing: optional refinement — derive the room name from the secret like channels do, so the URL carries only S and the room id is `hash(S)`; the "folder" is then addressed by its content, and a stale or guessed room name cannot be joined without S.
- Effort: medium. Worker: give hosts peer ids instead of the fixed `"host"`, route answers/candidates by host id, send a `peers` roster with `hostPresent`. Hosts (`share.ts`, `share.rs`): accept an explicit room link in addition to minting, and drop the "already serving room" refusal only for OTHER machines (keep it per machine). Viewers (`rtc.js`, `webrtcRemote.ts`): one peer connection per host; today both discard a second offer, which is exactly the place to branch. Console: map each host to a source. Reuse the worker's mesh roster rather than inventing a new frame set.

### 3. Federation through one hub machine

The hub serves a merged `/api/ls` from its remotes (the CLI already has the
snapshots) and proxies `/api/tail` and `/api/send` by host prefix.

- One URL: yes, the hub's existing share link.
- Keys: the hub's secret grants everything on every member; members only need to be reachable from the hub.
- Adding later: `ay connect` on the hub, no URL change.
- Offline member: the hub shows the cached snapshot with its age (PR #507 behaviour), which is a nice property.
- Cost: every byte of every member's tail transits the hub twice (member → hub → browser), the hub becomes a single point of failure, and the hub must reach each member (needs TURN in the Mac → JR direction). Effort: medium, mostly in `ts/serve.ts`. Reasonable when one machine is always on and well connected; a worse fit for a laptop + workstation pair.

### 4. libp2p swarm as the room

A gossipsub topic is a content-addressed room and peers find each other by
mDNS/Kademlia, but there is no browser transport and no console path; it would
need a gateway machine that is Option 3 again. Large effort, no web console
win. Not for this ask.

### 5. Existing codehost room (zero console work)

Already supported by the console: run `codehost serve --token <T>` on every
machine, open `https://agent-yes.com/w/#t=<T>` (or add `ch:<T>` as a source).
Each machine registers itself, advertises agents, and proxies its `ay serve`
API over its own tunnel.

- One URL: yes, and it never changes.
- Keys: one bearer token (12+ chars, validated by CLI, page and worker); same revocation story as Option 2.
- Adding later: start the daemon with the token on the new machine.
- Offline member: drops out of the roster.
- Caveats: a second daemon on each machine (codehost, not agent-yes), STUN-only, and the room lives on codehost's worker rather than agent-yes's. Effort: none in agent-yes; worth a live check that `codehost serve` still advertises agents and proxies `/__codehost/agent-yes/*` against current `ay serve`.

## Recommendation

- Now: Option 5 if a codehost daemon per machine is acceptable; it is the only path that is one URL today. Otherwise Option 1 as a one-day stopgap.
- Build: Option 2. It is the native answer, reuses the worker's roster and the console's machine grouping, keeps the URL stable, and can adopt content addressing (`room = hash(S)`) in the same change.
- Regardless of option: land TURN for the Rust host (PR #509); without a relay a member behind a symmetric NAT cannot be reached from another network in any design.

## Open questions

- Multi-host star vs. mesh mode for Option 2: mesh already has the roster and per-peer routing; using it means viewers and hosts share one wire, but hosts would then see each other's `peer-join` and must ignore host → host offers.
- Permission model beyond one secret: per-member keys with a grants table are sketched in `docs/agent-sharing.md` (Option Y) and apply unchanged to a multi-host room.
- Naming: `ay share --room` vs. reusing `ay connect` on the host side (a host "connecting" to a room it then serves).
