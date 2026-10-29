# Embedding the chat box

`<liagent-chat>` is a custom element with no dependencies: one ES module,
about 25 kB minified. It renders into its own shadow root at a fixed
position, so it fits any page and any framework. This guide covers:

1. [Loading it](#1-loading-it)
2. [Plain HTML, with a hub](#2-plain-html-with-a-hub)
3. [Your own transport](#3-your-own-transport)
4. [React](#4-react), including [replacing a hand-rolled chat box](#replacing-a-hand-rolled-chat-box)
5. [Vue, Svelte, Angular, Solid and Preact](#5-vue-svelte-angular-solid-and-preact)
6. [Reference](#6-reference): properties, callbacks, attributes, theming
7. [Security notes](#7-security-notes)

## 1. Loading it

The module defines nothing until you call `defineChatBox()`, and it is safe
to import during server rendering: the element class only extends
`HTMLElement` when one exists.

**As a dependency** (`bun add agent-yes`; the hub is `agent-yes/liagent/hub`):

```ts
const { defineChatBox, connectHub } = await import("agent-yes/liagent");
```

**From a hosted `liagent.js`** (a dev server, or your own static copy): import
it at run time. Tell your bundler to leave the URL alone, and keep the URL in
a variable so it is not resolved at build time:

```ts
const src = "https://example.com/static/liagent.js";
const mod = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ src);
mod.defineChatBox();
```

A cross-origin import needs `Access-Control-Allow-Origin` on the script, and
your CSP must allow its origin in `script-src` (see [7](#7-security-notes)).
The dev server (`bun run dev`) sends `Access-Control-Allow-Origin: *` and
`no-store`, and rebuilds the bundle on every request. Reloading the page picks
up your edits.

## 2. Plain HTML, with a hub

If your site runs the hub (`agent-yes/liagent/hub`, see the README), `connectHub` does
everything else. It holds the socket while the page is visible, and it shows
history, live messages, pairing requests, sessions and the busy spinner. It
also reads replies aloud.

```html
<script type="module">
  const { defineChatBox, connectHub } = await import("/static/liagent.js");
  defineChatBox();
  const box = document.createElement("liagent-chat");
  box.style.setProperty("--liagent-bg", "white"); // your page colour
  document.body.append(box);
  const hub = connectHub(box, {
    url: "/api/chat", // the hub's page socket, same origin or absolute
    evalCode: false, // true: run code an approved agent sends (eval hubs)
    wanted: () => true, // e.g. only in your debug mode; call hub.update() when it changes
  });
</script>
```

`hub.close()` drops the socket for good.

The page's label, which agents see, defaults to its path plus the user agent.
Pass `label` (a string, or a function asked again after each navigation) to
change it. The tab keeps a page id in `sessionStorage` and sends it on every
reconnect, so an app switch or a reload keeps the agents allowed on it.
Client-side navigation (`history.pushState`, `replaceState`,
back/forward) is reported to the hub after 300 ms, so agents hear
`page-changed`. Pass `trackPages: false` to turn that off.

## 3. Your own transport

The box knows nothing about sockets. Give it messages and state, and take its
callbacks:

```ts
box.onSend = (text) => mySend(text); // return false if it could not go out: the draft is kept
box.messages = history; // shown, never read aloud
box.push(message); // one live message; an agent's is read aloud
box.live = true; // the connection dot
box.listeners = 1; // "agent listening (1)"
box.beat(); // one busy beat from the agent: a spinner for 12 s, or until its reply
box.pages = state.pages; // the user's open pages, and which one this is:
box.self = state.self; //   offered as checkboxes when allowing, and ended from the menu
box.onAnswer = (type, pair, { pages, scope }) => myAnswer(type, pair, pages, scope);
box.onEndPage = (id) => myEndPage(id);
```

A message is `{ id, from: "owner" | "agent" | "friend", label, text, at }`
(`"owner"` is the wire's name for the user who owns the site).
The log shows `label` for an agent and "you" for everyone else. It renders
text only and never parses HTML.

## 4. React

Copy [`examples/react/LiagentChat.tsx`](../examples/react/LiagentChat.tsx)
into your app. It is a client component (React 19) that does three things:

- loads the bundle with your `load()`;
- creates the element (so `storageKey` and `defaultOpen` are set before it
  connects);
- hands it your props as element properties on every render.

The element is fixed-positioned and the wrapper renders `display: contents`,
so where you mount it doesn't matter.

```tsx
"use client";
import { useRef } from "react";
import { LiagentChat, type LiagentChatHandle } from "./LiagentChat";

const src = process.env.NEXT_PUBLIC_LIAGENT_URL!; // or use () => import("agent-yes/liagent")

export function Chat(props: {
  live: boolean;
  listeners: number;
  messages: ChatMessage[];
  onSend: (t: string) => boolean;
}) {
  const chat = useRef<LiagentChatHandle>(null);
  // When a reply arrives live: chat.current?.speak(reply.text)
  return (
    <LiagentChat
      ref={chat}
      load={() => import(/* webpackIgnore: true */ /* turbopackIgnore: true */ src)}
      storageKey="myapp:chat"
      style={{ "--liagent-bg": "var(--background)" }}
      {...props}
    />
  );
}
```

[`examples/react/HubChat.tsx`](../examples/react/HubChat.tsx) is a complete
page component that owns the hub socket and renders `<LiagentChat>`. Run it
with `bun run dev` and open `/liagent/react.html`.

### Replacing a hand-rolled chat box

`<LiagentChat>` takes the same props as a typical hand-rolled
`<DebugChat>`. In the component that holds the socket:

| Before                                                                               | After                                                                        |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `import { DebugChat, speakReply } from "./DebugChat"`                                | `import { LiagentChat, type LiagentChatHandle } from "./LiagentChat"`        |
| `<DebugChat live listeners messages onSend …/>`                                      | `<LiagentChat ref={chat} load={…} live listeners messages onSend …/>`        |
| `sessions`, `onEnd`, `pending`, `onAnswer`, `evalRan`, `friend`, `notice`, `warning` | the same names                                                               |
| `speakReply(m.text)` for a live agent message                                        | `chat.current?.speak(m.text)`                                                |
| a spinner of your own                                                                | `chat.current?.beat()` on each `{type:"busy"}` from the hub                  |
| a pairing prompt with page choice                                                    | `pages={state.pages} self={state.self}`; `onAnswer(type, p, {pages, scope})` |
| ending one of the user's pages                                                       | `onEndPage={(id) => send({type: "end-page", id})}`                           |
| the default-open rule (e.g. collapsed on one route)                                  | `defaultOpen={!location.pathname.startsWith("/route")}`                      |
| per-device keys (`app:chat-open`, `-speak`, `-pos`)                                  | `storageKey="app:chat"` → `app:chat:open`, `:speak`, `:pos`                  |

The storage key layout differs, so each device starts once from the default
open state, with read-aloud on and the box at its home position.

## 5. Vue, Svelte, Angular, Solid and Preact

The rules are the same everywhere:

- **Define the element before the framework renders it.** Frameworks set a
  binding as a property only when the element already has that property.
- **Bind data as properties, not attributes:** `messages`, `pending`,
  `sessions` and the rest are arrays and objects.
- **Set the callbacks on the element itself.** Several frameworks treat any
  `on*` binding as an event listener, or refuse it outright.
- **Or use `connectHub`:** hand it the element once it is mounted, and it
  sets every property and callback itself.

Each snippet below has a complete, runnable page under `examples/<name>/`.
Run `bun run dev` and open `/liagent/examples/<name>/` for a fake agent, or
add `?hub` to use the dev hub. The pages load their framework from esm.sh
at a pinned version, so they need no build.

| Framework  | Data props                | Callbacks (`onSend`, `onAnswer`, `onEnd`)                 | Example                                             |
| ---------- | ------------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| Plain HTML | `box.messages = …`        | `box.onSend = …`                                          | [examples/html](../examples/html/index.html)        |
| React 19   | the wrapper sets them     | the wrapper sets them                                     | [examples/react](../examples/react/LiagentChat.tsx) |
| Vue 3      | `:messages.prop="…"`      | `:onSend.prop="send"`                                     | [examples/vue](../examples/vue/index.html)          |
| Svelte 5   | `{messages}`              | through `bind:this` (`on*` are events)                    | [examples/svelte](../examples/svelte/index.html)    |
| Angular    | `[messages]="messages()"` | through `@ViewChild` (`on*` bindings are refused, NG0306) | [examples/angular](../examples/angular/index.html)  |
| Solid      | `prop:messages={…}`       | `prop:onSend={send}` (`() => send` in `solid-js/html`)    | [examples/solid](../examples/solid/index.html)      |
| Preact     | `messages={…}`            | through a ref (`on*` are events)                          | [examples/preact](../examples/preact/index.html)    |

### Vue 3

Tell the template compiler that `liagent-` tags are custom elements, then
bind with `.prop`:

```ts
// vite.config.ts
vue({ template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith("liagent-") } } });
// or, compiling in the browser: app.config.compilerOptions.isCustomElement = …
```

```vue
<script setup lang="ts">
import { onMounted, ref } from "vue";
import { connectHub } from "agent-yes/liagent";
const messages = ref([]);
const send = (text: string) => mySend(text); // true if it went out
const box = ref<HTMLElement>();
// With a hub instead: onMounted(() => connectHub(box.value, { url: "/api/chat" }));
</script>

<template>
  <liagent-chat
    ref="box"
    storage-key="myapp:chat"
    :live.prop="live"
    :messages.prop="messages"
    :pending.prop="pending"
    :onSend.prop="send"
    :onAnswer.prop="answer"
    :onEnd.prop="end"
  />
</template>
```

### Svelte 5

Data props are set as properties. Attributes named `on…` are event listeners
in Svelte 5, so set the callbacks through `bind:this`:

```svelte
<script>
  import { onMount } from "svelte";
  let box = $state();
  let messages = $state([]);
  onMount(() => {
    box.onSend = (text) => mySend(text);
    box.onAnswer = (type, pair, answer) => myAnswer(type, pair, answer);
    box.onEnd = (pair) => myEnd(pair);
    // With a hub instead: connectHub(box, { url: "/api/chat" });
  });
</script>

<liagent-chat bind:this={box} storage-key="myapp:chat" live={true} {messages} {pending} {sessions}></liagent-chat>
```

### Angular

Add `CUSTOM_ELEMENTS_SCHEMA`. Property bindings work for data, but Angular
refuses any `on*` binding (NG0306), so set the callbacks from a `@ViewChild`:

```ts
@Component({
  selector: "app-chat",
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `<liagent-chat
    #box
    storage-key="myapp:chat"
    [live]="live()"
    [messages]="messages()"
    [pending]="pending()"
    [sessions]="sessions()"
  ></liagent-chat>`,
})
export class ChatComponent implements AfterViewInit {
  @ViewChild("box") box!: ElementRef<HTMLElement & Record<string, unknown>>;
  messages = signal<ChatMessage[]>([]);
  send = (text: string) => mySend(text); // arrow fields keep `this`
  ngAfterViewInit() {
    const el = this.box.nativeElement;
    el.onSend = this.send;
    el.onAnswer = this.answer;
    el.onEnd = this.end;
    // With a hub instead: connectHub(el, { url: "/api/chat" });
  }
}
```

### Solid

Use `prop:` for everything, so each value is set as a property. In JSX,
declare the tag's props in a `declare module "solid-js"` block:

```tsx
<liagent-chat
  storage-key="myapp:chat"
  prop:live={live()}
  prop:messages={messages()}
  prop:onSend={send}
  prop:onAnswer={answer}
  prop:onEnd={end}
/>
// With a hub instead: <liagent-chat ref={(el) => onMount(() => connectHub(el, { url: "/api/chat" }))} />
```

In `solid-js/html` (no build), a function value is read as a reactive
getter: pass a callback as `prop:onSend=${() => send}`, and a signal as the
signal itself.

### Preact

Data props are set as properties. Props named `on…` are event listeners in
Preact, so set the callbacks through a ref:

```jsx
function Chat() {
  const box = useRef(null);
  const [messages, setMessages] = useState([]);
  useEffect(() => {
    box.current.onSend = (text) => mySend(text);
    box.current.onAnswer = (type, pair, answer) => myAnswer(type, pair, answer);
    box.current.onEnd = (pair) => myEnd(pair);
    // With a hub instead: connectHub(box.current, { url: "/api/chat" });
  }, []);
  return <liagent-chat ref={box} storage-key="myapp:chat" live={true} messages={messages} />;
}
```

### A note on React 19

React 19 also sets custom-element props as properties when the element has
them, and treats `on…` props as events. The wrapper in
[examples/react](../examples/react/LiagentChat.tsx) sidesteps both: it
creates the element itself and assigns every prop and callback in a layout
effect.

## 6. Reference

**Properties** (set them; each re-renders only its own part of the box):

| Property      | Type               | Meaning                                                                                                                                                                                                                                             |
| ------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messages`    | `ChatMessage[]`    | The log (the last 200). Replacing it never reads aloud.                                                                                                                                                                                             |
| `live`        | `boolean`          | Connected: the green dot, and the status text.                                                                                                                                                                                                      |
| `listeners`   | `number`           | Agents listening, in the status.                                                                                                                                                                                                                    |
| `sessions`    | `PairInfo[]`       | Approved agents: an icon each for eval, and a line with End in the menu.                                                                                                                                                                            |
| `pending`     | `PairInfo \| null` | A pairing request: its code, what it asks for (`chat · 30d` or `code · 8h`), Allow and ✕, plus page checkboxes for code (eval) when several pages are open; chat always covers every page. An older agent that names no scope gets `8h · chat · ✕`. |
| `pages`       | `PageInfo[]`       | The user's open pages (the hub's `state.pages`).                                                                                                                                                                                                    |
| `self`        | `string`           | Which of them this page is (`state.self`).                                                                                                                                                                                                          |
| `evalRan`     | `boolean`          | Code just ran here: the eval icons pulse.                                                                                                                                                                                                           |
| `busy`        | `boolean`          | The spinner, set by hand (`beat()` is the timed way).                                                                                                                                                                                               |
| `friend`      | `boolean`          | A friend's page, not the user's: no chat grant offered, sessions say "preview".                                                                                                                                                                     |
| `notice`      | `string`           | Replaces the input (say, "Chat is not available").                                                                                                                                                                                                  |
| `warning`     | `string`           | One line above the input (say, a rate limit).                                                                                                                                                                                                       |
| `defaultOpen` | `boolean`          | Open or collapsed on first visit. Set it before attaching.                                                                                                                                                                                          |
| `placeholder` | `string`           | The input's placeholder.                                                                                                                                                                                                                            |

**Methods:**

- `push(message)`: appends one live message, deduplicated by id. An agent's
  is read aloud and ends the spinner.
- `beat()`: one busy beat. The spinner shows for 12 s unless another beat
  renews it or a reply ends it, and a beat within 1.5 s after a reply is
  ignored.
- `speak(text)`: reads text aloud if the device has read-aloud on.
- `submit()`: sends the draft now.

**Callbacks:**

- `onSend(text) → boolean`
- `onAnswer("allow" | "deny", pair, { pages?, scope? })`: `pages` holds the
  ticked page ids, or `"all"`. `scope` is `"chat"` only when an older agent's
  prompt was answered with the 30-day chat button.
- `onEnd(pair)`: End on an agent's session in the menu.
- `onEndPage(id)`: End on one of the user's pages in the menu. Ending this
  page takes a second tap.

**Attributes:**

- `storage-key`: the localStorage prefix. Default `liagent`.
- `collapsed`: the same as `defaultOpen = false`.
- `placeholder`

**Theming** (CSS custom properties on the element):

| Variable          | Default                    | Used for                                                                               |
| ----------------- | -------------------------- | -------------------------------------------------------------------------------------- |
| `--liagent-bg`    | `Canvas`                   | The halo behind the text, and the translucent input (55%). Set it to your page colour. |
| `--liagent-fg`    | `CanvasText`               | Text                                                                                   |
| `--liagent-you`   | `oklch(0.55 0.13 250)`     | "you:"                                                                                 |
| `--liagent-agent` | `oklch(0.55 0.14 150)`     | The agent's name, and the spinner                                                      |
| `--liagent-z`     | `40`                       | z-index                                                                                |
| `--liagent-width` | `min(20rem, 100vw - 1rem)` | Box width                                                                              |

**Behaviour:** the header of [`src/box.ts`](../src/box.ts) covers it. When a
draft is sent is in [`src/input.ts`](../src/input.ts):

- 3 s after typing stops;
- on Enter, but not Shift+Enter, and never during IME composition;
- on Android, on the line break itself;
- at once, when dictation inserts more than 10 characters that end a sentence.

## 7. Security notes

- **Cross-site WebSocket hijacking:** `routeChat` refuses a page socket
  whose `Origin` is not the request's own origin, before it calls
  `identify`. So a site the user visits cannot open your hub's socket with
  their cookie and act as them. If your pages live on another origin than
  the hub (`app.example.com` vs `api.example.com`), list it:
  `routeChat(req, env.CHAT, { identify, allowedOrigins: ["https://app.example.com"] })`.
  Prefer `SameSite=Lax` or `Strict` session cookies too.

- **The page side is your site's call.** The hub accepts only pages that
  your `identify(req)` vouches for. An agent can do nothing until the user
  approves it in the box, on the pages they choose, after matching the
  short code its terminal shows.
- **Eval is off by default** on both ends: the hub needs `chatHub({ eval: true })`,
  and `connectHub` needs `evalCode: true`. With both on, an approved agent
  runs arbitrary code in the pages the user allowed. Keep it to debug sessions.
- **CSP:** a hosted `liagent.js` needs its origin in `script-src`, and the
  hub's socket needs it in `connect-src`. The box styles its shadow root with
  a constructed stylesheet (`adoptedStyleSheets`), which `style-src` does not
  block, so it needs no `'unsafe-inline'`. Only browsers without constructed
  stylesheets fall back to a `<style>` element.
- **Prompt injection:** with `liagent listen --to <agent>`, every message is
  typed into a coding agent, and friends' messages too: any signed-in user
  can put text in front of the user's agent. Nothing reaches a shell
  (delivery goes through `ay send` with no shell in between), but the text
  is a prompt. The agent's skill (SKILL.md) treats friends' messages as
  untrusted and never acts on them beyond replying. If your site lets
  strangers sign in, consider not delivering friends' threads to an agent
  at all (run `listen` without `--to` and read the JSON lines), or keep
  the friends feature off by not identifying non-owners in `identify`.
- **Text only:** the box sets message text with `textContent`, so a message
  can never inject markup.
