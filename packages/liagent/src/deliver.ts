// What `liagent listen --to` types into an agent-yes agent for one chat
// message. Pure, so it is unit tested (test/deliver.test.ts).

import type { ChatMessage } from "./protocol.ts";

/**
 * `ay send` refuses more than 1024 chars per send, and a long paste into a
 * live CLI gets mangled anyway: past this, the agent gets a preview and the
 * path of a file with the whole message.
 */
export const SEND_MAX = 900;
/** The text one chat message is delivered as: a header with the reply command, then the body. */
export function deliveryText(
  hub: string,
  m: ChatMessage & { email?: string },
  spill: (id: string, text: string) => string,
): string {
  const who = m.from === "friend" ? `friend ${m.email || m.thread}` : "the user";
  const replyTo = m.from === "friend" ? ` --to ${m.email || m.thread}` : "";
  const page = m.label.split(" ")[0] || "?";
  const header = `[liagent ${m.id}] ${who} wrote in the chat box (${page}) — reply: liagent say ${hub}${replyTo} "..."\n`;
  if (header.length + m.text.length <= SEND_MAX) return header + m.text;
  const path = spill(m.id, m.text);
  const room = Math.max(0, SEND_MAX - header.length - path.length - 40);
  return `${header}${m.text.slice(0, room)}… (${m.text.length} chars; the whole message: ${path})`;
}
