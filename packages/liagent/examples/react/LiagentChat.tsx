"use client";
// <LiagentChat>: the <liagent-chat> box as a React component (React 19).
// Copy this file into your app. Its props are the box's properties and
// callbacks, so a component that rendered its own chat box can swap it in
// without changing what it passes.
//
//   const chat = useRef<LiagentChatHandle>(null);
//   <LiagentChat
//     ref={chat}
//     load={() => import("@agent-yes/liagent")}       // or a URL; see `load` below
//     live={live} listeners={n} messages={messages} onSend={send} … />
//   chat.current?.speak(reply.text);       // a reply that arrived live
//
// The element is defined when `load` resolves (a dynamic import, so it never
// runs on the server); until then nothing renders. Props are set as element
// properties in a layout effect — never as attributes — so arrays and
// callbacks pass through as they are.

import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import type { ChatBox } from "@agent-yes/liagent/box";
import type { Answer } from "@agent-yes/liagent/box";
import type { ChatMessage, PageInfo, PairInfo } from "@agent-yes/liagent/protocol";

type LiagentModule = { defineChatBox: (tag?: string) => unknown };

export type LiagentChatHandle = {
  /** Read a reply aloud (if the device has it on): call it for a reply that arrived live. */
  speak(text: string): void;
  /** One busy beat from the agent (the hub's {type:"busy"}): the box times the spinner out. */
  beat(): void;
  /** The element itself, once defined. */
  element(): ChatBox | null;
};

export type LiagentChatProps = {
  /**
   * Load the bundle: `() => import("@agent-yes/liagent")` when it is a dependency, or
   * `() => import(/* webpackIgnore: true *\/ url)` for a hosted liagent.js.
   */
  load: () => Promise<LiagentModule>;
  live: boolean;
  listeners: number;
  messages: ChatMessage[];
  onSend: (text: string) => boolean;
  sessions?: PairInfo[];
  onEnd?: (s: PairInfo) => void;
  pending?: PairInfo | null;
  onAnswer?: (type: "allow" | "deny", p: PairInfo, answer: Answer) => void;
  /** The user's open pages (hub state.pages) and which one this is (state.self). */
  pages?: PageInfo[];
  self?: string;
  onEndPage?: (id: string) => void;
  evalRan?: boolean;
  busy?: boolean;
  /** A friend's page: pairings are previews, with no chat scope to grant. */
  friend?: boolean;
  notice?: string;
  warning?: string;
  /** Open on first visit (later visits remember the owner's choice). Default true. */
  defaultOpen?: boolean;
  /** localStorage prefix for the box's per-device settings. Default "liagent". */
  storageKey?: string;
  placeholder?: string;
  /** Element styles: theme it with --liagent-bg and friends. */
  style?: React.CSSProperties & Record<`--${string}`, string>;
  ref?: Ref<LiagentChatHandle>;
  /** The custom element's tag. Default "liagent-chat". */
  tag?: string;
};

export function LiagentChat({
  load,
  ref,
  tag = "liagent-chat",
  storageKey,
  defaultOpen = true,
  style,
  ...props
}: LiagentChatProps) {
  const [ready, setReady] = useState(false);
  const host = useRef<HTMLDivElement | null>(null);
  const box = useRef<ChatBox | null>(null);
  // The latest callbacks, so the element's are set once and never go stale.
  const cb = useRef(props);
  cb.current = props;

  useEffect(() => {
    let gone = false;
    load()
      .then((m) => {
        m.defineChatBox(tag);
        if (!gone) setReady(true);
      })
      .catch((e) => console.error("liagent: could not load the chat box", e));
    return () => {
      gone = true;
    };
    // Loaded once per mount; a new `load` function each render is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag]);

  // Create the element by hand: its settings (storage key, default open) must
  // be in place before it connects, and React would connect it first.
  useLayoutEffect(() => {
    if (!ready || !host.current) return;
    const el = document.createElement(tag) as ChatBox;
    if (storageKey) el.setAttribute("storage-key", storageKey);
    el.defaultOpen = defaultOpen;
    el.onSend = (text) => cb.current.onSend(text);
    el.onEnd = (s) => cb.current.onEnd?.(s);
    el.onAnswer = (type, p, answer) => cb.current.onAnswer?.(type, p, answer);
    el.onEndPage = (id) => cb.current.onEndPage?.(id);
    host.current.append(el);
    box.current = el;
    return () => {
      el.remove();
      box.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, tag, storageKey]);

  // Every render: hand the element the current values (each setter re-renders
  // only its own part of the box).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (el.messages !== props.messages) el.messages = props.messages;
    el.live = props.live;
    el.listeners = props.listeners;
    el.sessions = props.sessions ?? [];
    el.pending = props.pending ?? null;
    el.evalRan = !!props.evalRan;
    if (props.busy !== undefined) el.busy = props.busy;
    el.pages = props.pages ?? [];
    el.self = props.self ?? "";
    el.friend = !!props.friend;
    el.notice = props.notice;
    el.warning = props.warning;
    if (props.placeholder) el.placeholder = props.placeholder;
    for (const [k, v] of Object.entries(style ?? {})) el.style.setProperty(k, String(v));
  });

  useImperativeHandle(
    ref,
    () => ({
      speak: (text) => box.current?.speak(text),
      beat: () => box.current?.beat(),
      element: () => box.current,
    }),
    [],
  );

  // `display: contents`: the wrapper takes no space; the box is position: fixed.
  return <div ref={host} style={{ display: "contents" }} />;
}
