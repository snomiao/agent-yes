# liagent

User ⇄ agent chat for any web page: a floating chat box (a framework-free
custom element), the hub it talks to, and the agent's CLI.

The CLI and the dev server need [Bun](https://bun.sh).

Status: early. It ships inside the [agent-yes](https://github.com/snomiao/agent-yes)
npm package, released with it; this directory (`packages/liagent`) is its
source and is not published on its own.

```bash
bun add agent-yes
```

| Import                                          | What                                                     |
| ----------------------------------------------- | -------------------------------------------------------- |
| `agent-yes/liagent`                             | the box, `connectHub`, and the protocol (browser)        |
| `agent-yes/liagent/box`, `/client`, `/protocol` | each part on its own                                     |
| `agent-yes/liagent/hub`                         | the hub (a Cloudflare Durable Object) and `routeChat`    |
| `agent-yes/liagent/liagent.js`                  | the standalone browser bundle, for `import()` from a URL |
| `liagent` (bin)                                 | the agent's CLI                                          |

These entries import nothing from the rest of agent-yes, so a bundler that
imports `agent-yes/liagent` never reaches the agent-yes CLI or its native
dependencies.

## The box

```js
const { defineChatBox, connectHub } = await import("https://…/liagent.js");
defineChatBox(); // <liagent-chat>
const box = document.body.appendChild(document.createElement("liagent-chat"));

// Either drive it yourself…
box.onSend = (text) => mySocketSend(text); // return false to keep the draft
box.messages = history; // shown, never read aloud
box.push(message); // live: an agent's reply is read aloud

// …or from a hub's page socket:
const hub = connectHub(box, { url: "wss://example.com/api/chat" });
```

Properties: `messages`, `live`, `listeners`, `sessions`, `pending`, `evalRan`,
`busy`, `guest`, `notice`, `warning`, `defaultOpen`, `placeholder`.
Callbacks: `onSend(text) → boolean`, `onAnswer(type, pair, scope?)`, `onEnd(pair)`.
Attributes: `storage-key` (localStorage prefix, default `liagent`), `collapsed`,
`placeholder`. Theme: `--liagent-bg` (set it to your page colour),
`--liagent-fg`, `--liagent-you`, `--liagent-agent`, `--liagent-z`,
`--liagent-width`.

[docs/embed.md](docs/embed.md) shows how to embed it: plain HTML, your own
transport, React, Vue, Svelte, Angular, Solid and Preact (each with a runnable
page under `examples/`), and a full reference. See the header of `src/box.ts` for the behaviour, and `src/input.ts` for when
a draft is sent.

## The hub

A Cloudflare Durable Object your site hosts in its own Worker, because only
your site can say who a page belongs to:

```ts
import { chatHub, routeChat } from "agent-yes/liagent/hub";
export const ChatHub = chatHub({ eval: false }); // bind it as CHAT in wrangler config

export default {
  async fetch(req: Request, env: Env) {
    const chat = await routeChat(req, env.CHAT, {
      identify: (req) => mySession(req), // {userId, email, owner: is it the site's user?} | null
    });
    return chat ?? myRoutes(req, env);
  },
};
```

Pages connect to `/api/chat` (the box's `connectHub`), agents to
`/api/chat/control` (the CLI). An agent asks for a scope: **chat** (30 days,
with a resumable token of which only the hash is stored) or **eval** (an
hour of running code, only on a hub made with `{ eval: true }`). It can do
nothing until the user allows it in the box, on the pages they tick, or all
of them. Signed-in others ("friends") get their own thread, rate-limited.
The header of `src/hub.ts` has the details and the wire.

## The agent's CLI

```bash
export LIAGENT_HUB=https://dev.example.com/api/chat
liagent pair                 # prints a code; the user taps Allow in the box
liagent listen --to <agent>  # messages → JSON lines, and into an agent-yes agent
liagent say "On it."         # reply in the box
liagent busy --every 4 &     # the box's spinner, until your next reply
liagent eval 'document.title'  # eval hubs only; the user allows it on chosen pages
```

[SKILL.md](SKILL.md) is the agent skill: how an AI agent should pair,
listen, reply, and behave in the chat.

## Develop

```bash
bun install
bun test
bun run typecheck
bun run dev     # http://127.0.0.1:8861/liagent/ — the demo; liagent.js rebuilt per request
                # …/liagent/?hub — the same box on a local hub (EVAL=1 for eval)
bun run build   # dist/liagent.js
```
