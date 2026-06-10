# lab/ui — interactive web console for agent-yes

A prototype web dashboard for agent-yes, grown out of peeking at **codehost**
(the read-only access list on `:7700`) and asking what agent-yes can do that
codehost structurally can't.

```bash
./run.sh          # starts `ay serve` :7432 + the lab UI :7777
open http://localhost:7777
```

## What it is

Two panes, GitHub-dark, no build step:

- **Left — live list.** Polls `GET /api/ls` every 3 s and renders every agent
  as a flat row with status dot, `cli`, `pid`, age, prompt, and mnemonic
  `repo:` / `wt:` / `cli:` tags derived from the `cwd`. Space-separated filter
  with `key:value` AND tokens — lifted straight from codehost.
- **Right — tail + send.** Click an agent → its log streams into the right pane
  and a composer at the bottom writes straight to its stdin
  (`POST /api/send`). **This is the half codehost cannot have.**

No new backend: `ay serve` already exposes the whole API. `server.ts` is a
~50-line same-origin proxy that serves `index.html` and forwards `/api/*` with
the `Authorization: Bearer <token>` (read from `~/.agent-yes/.serve-token`)
injected — so the browser needs no token and hits no CORS wall.

## What we learned from codehost

codehost (`~/ws/snomiao/codehost`, `:7700`) does several things worth keeping:

1. **One flat table, not a tree.** Everything reachable right now in a single
   scannable list — agents and daemons side by side.
2. **Tags are mnemonics, not identity.** `host:` / `repo:` / `wt:` tags exist
   only to filter and remember; the canonical id stays the hard `pid`/peerId.
   We mirror this: tags are derived from `cwd`, the `pid` is the real handle.
3. **Filter-as-you-type with `key:value` AND tokens** — fast, keyboard-first,
   no menus. Copied wholesale.
4. **A tight GitHub-dark palette** that reads as one system. Reused verbatim so
   the two consoles feel related.

What codehost **can't** do, and we should: it only renders `ay ls`. agent-yes
owns each agent's `log_file` and `fifo_file`, so it can **tail and talk back**.
That read-write layer is the reason for a first-party UI.

## What we found we should improve in agent-yes

- **No HTML is served by `ay serve`.** The API is great but headless. A
  first-party `ay serve --ui` (or shipping this page at `/`) would make the
  whole thing usable without a side-car proxy.
- **The root `index.html` is a static marketing page**, unrelated to the live
  tooling. A real product would make the landing page _be_ this console.

## Files

| file         | role                                                       |
| ------------ | ---------------------------------------------------------- |
| `run.sh`     | starts `ay serve` + the proxy, prints the URL              |
| `server.ts`  | same-origin static + `/api/*` proxy (injects the token)    |
| `index.html` | the two-pane console (list + tail/send), zero dependencies |

## API surface used (all from `ay serve`)

- `GET  /api/ls?all=1` — list agents
- `GET  /api/read/:pid?mode=tail&n=200` — one-shot xterm-rendered log tail
- `GET  /api/tail/:pid` — SSE stream; the live tail (`EventSource`) this UI uses
- `POST /api/send` `{keyword, msg, code}` — write to the agent's stdin fifo
