// Debug chat for the site owner: a liagent hub (agent-yes/liagent, the
// snolab/liagent package) that connects the console's debug-mode chat box
// (lab/ui/debug.js) to an agent developing agent-yes.
//
//   page   wss://agent-yes.com/_ay/chat           the box, owner session only
//   agent  wss://agent-yes.com/_ay/chat/control   `LIAGENT_HUB=https://agent-yes.com/_ay/chat
//                                                  liagent pair` — inert until the owner
//                                                  taps Allow in the box
//
// identify() admits the owner (auth.ts isOwner) and nobody else: every other
// session gets null, so the hub has no "friends" threads. Eval is on, because
// debugging the frontend is the point: an agent the owner approves may run code
// in the pages the owner ticks, for 8 hours at most. Apex only, like auth.

import { chatHub, routeChat } from "liagent/hub";
import { isOwner, sessionUser, type AuthEnv } from "./auth";

export const CHAT_PATH = "/_ay/chat";

export const ChatHub = chatHub({ eval: true });

export interface ChatEnv extends AuthEnv {
  CHAT: DurableObjectNamespace;
}

/** The hub's answer for a request under CHAT_PATH, or null for any other path. */
export function handleChat(req: Request, env: ChatEnv, origin: string): Promise<Response | null> {
  return routeChat(req, env.CHAT, {
    pagePath: CHAT_PATH,
    identify: async (req) => {
      const user = await sessionUser(req, env, origin);
      return user && isOwner(user) ? { userId: user.id, email: user.email, owner: true } : null;
    },
  });
}
