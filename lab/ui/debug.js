// Debug mode for the console: a chat with an agent developing agent-yes,
// right on the page (liagent's <liagent-chat> box, hub in cf/liagent.ts).
//
// Off unless asked for: open the console with ?debug (remembered in this
// browser; ?debug=0 forgets it). Then:
//   - not signed in   → a small "Sign in with GitHub" button
//   - the site owner  → the chat box (an agent can only reach it after the
//                       owner taps Allow in the box)
//   - anyone else     → a note that debug mode is the owner's, and sign-out
// The server enforces all of this (only the owner's session may open the chat
// socket); this module only decides what to show. Where the site has no sign-in
// (`ay serve`, beta Pages) the auth route is missing and this does nothing.

const AUTH = "/_ay/auth";
const CHAT = "/_ay/chat";
const OWNER_EMAIL = "snomiao@gmail.com";
const KEY = "ay.debug";

/** Whether debug mode is on: ?debug turns it on (and remembers), ?debug=0 off. */
export function debugWanted(search, store) {
  const v = new URLSearchParams(search).get("debug");
  try {
    if (v === "0" || v === "false") store.removeItem(KEY);
    else if (v !== null) store.setItem(KEY, "1");
    return store.getItem(KEY) === "1";
  } catch {
    return v !== null && v !== "0" && v !== "false";
  }
}

/** What a session (better-auth get-session's body) allows: "owner", "other" or "none". */
export function debugRole(session) {
  const u = session?.user;
  if (!u) return "none";
  return u.emailVerified && String(u.email).toLowerCase() === OWNER_EMAIL ? "owner" : "other";
}

function corner(...children) {
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;left:12px;bottom:12px;z-index:2147483000;display:flex;gap:8px;align-items:center;" +
    "font:12px system-ui,sans-serif;color:var(--fg,#c9d1d9);background:var(--panel,#161b22);" +
    "border:1px solid var(--line,#2d3748);border-radius:8px;padding:6px 8px";
  el.append(...children);
  document.body.append(el);
  return el;
}

function button(label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.style.cssText = "font:inherit;cursor:pointer";
  b.addEventListener("click", onClick);
  return b;
}

const authPost = (path, body) =>
  fetch(AUTH + path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

async function signIn() {
  const res = await authPost("/sign-in/social", { provider: "github", callbackURL: location.href });
  const { url } = await res.json().catch(() => ({}));
  if (url) location.href = url;
}

async function signOut() {
  await authPost("/sign-out");
  location.reload();
}

async function mountChat(user) {
  const { defineChatBox, connectHub } = await import("./liagent.js");
  defineChatBox();
  const box = document.createElement("liagent-chat");
  box.setAttribute("storage-key", "ay.liagent");
  box.style.setProperty("--liagent-bg", "var(--bg)");
  box.style.setProperty("--liagent-fg", "var(--fg)");
  box.agentAvatar = "./icon.svg";
  box.userName = user.name || user.email;
  box.userId = user.id;
  box.placeholder = "Debug chat with the agent-yes dev agent";
  document.body.append(box);
  connectHub(box, { url: CHAT, evalCode: true });
}

export async function startDebug() {
  if (!debugWanted(location.search, localStorage)) return;
  const res = await fetch(`${AUTH}/get-session`, { credentials: "same-origin" }).catch(() => null);
  if (!res?.ok || !(res.headers.get("content-type") ?? "").includes("json")) return;
  const session = await res.json().catch(() => null);
  const role = debugRole(session);
  if (role === "owner") return mountChat(session.user);
  if (role === "none") return void corner(button("Debug: sign in with GitHub", signIn));
  const note = document.createElement("span");
  note.textContent = `Debug mode is for the site owner (signed in as ${session.user.email}).`;
  corner(note, button("Sign out", signOut));
}

if (typeof document !== "undefined") startDebug().catch((e) => console.warn("[ay debug]", e));
