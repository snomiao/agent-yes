"use client";
// A page component that owns the hub socket and renders <LiagentChat>: the
// shape of an app that already holds its own socket (for eval, pairing, its
// own logging) and only wants the box. If you hold no socket of your own,
// skip this and call connectHub(element, {url}) from liagent instead.

import { useEffect, useRef, useState } from "react";
import type { ChatMessage, HubState } from "agent-yes/liagent/protocol";
import { LiagentChat, type LiagentChatHandle, type LiagentChatProps } from "./LiagentChat";

const trim = (list: ChatMessage[]) => list.slice(-200);

export function HubChat({ url, load }: { url: string; load: LiagentChatProps["load"] }) {
  const [live, setLive] = useState(false);
  const [state, setState] = useState<HubState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const chat = useRef<LiagentChatHandle>(null);
  const sock = useRef<WebSocket | null>(null);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    const connect = () => {
      const u = new URL(url, location.href);
      u.protocol = u.protocol === "https:" ? "wss:" : u.protocol === "http:" ? "ws:" : u.protocol;
      u.searchParams.set("label", `${location.pathname} ${navigator.userAgent}`);
      ws = sock.current = new WebSocket(u);
      ws.onopen = () => setLive(true);
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.type === "state") setState(msg as HubState);
        else if (msg.type === "busy") chat.current?.beat();
        else if (msg.type === "history") setMessages(trim(msg.messages));
        else if (msg.type === "chat") {
          const m = msg.message as ChatMessage;
          setMessages((list) => (list.some((x) => x.id === m.id) ? list : trim([...list, m])));
          // Live replies only: history is never read aloud.
          if (m.from === "agent") chat.current?.speak(m.text);
        }
      };
      ws.onclose = (e) => {
        setLive(false);
        setState(null);
        if (!closed && e.code < 4000) setTimeout(connect, 1000);
      };
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, [url]);

  const send = (m: unknown) => {
    const ws = sock.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(m));
    return true;
  };

  return (
    <LiagentChat
      ref={chat}
      load={load}
      live={live}
      listeners={state?.listeners ?? 0}
      messages={messages}
      sessions={state?.sessions ?? []}
      pending={state?.pending ?? null}
      pages={state?.pages ?? []}
      self={state?.self ?? ""}
      onSend={(text) => send({ type: "chat", id: crypto.randomUUID().slice(0, 12), text })}
      onAnswer={(type, p, answer) =>
        void send(type === "deny" ? { type, pair: p.pair } : { type, pair: p.pair, ...answer })
      }
      onEndPage={(id) => void send({ type: "end-page", id })}
      onEnd={(p) => void send({ type: "revoke", pair: p.pair })}
      style={{ "--liagent-bg": "var(--background)" }}
    />
  );
}
