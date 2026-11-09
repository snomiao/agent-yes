// The profile menu: optional sign-in for agent-yes.com, and the data panel.
//
// Sign-in is never required: rooms, share links and tokens work exactly the same
// without it. This module shows NOTHING unless the site says sign-in exists
// here: GET /_ay/auth/providers must answer 200 with at least one provider. A
// self-hosted domain, the local `ay serve` console, beta Pages and a deployment
// without secrets all answer 404/503 (or serve no such route), so no button
// appears and the console is exactly what it was.
//
// Signed out: one button, "Sign in", listing the providers the site offers.
// Signed in: the avatar opens a menu with the user's name and email, "My data"
// (a panel over everything the console keeps for them) and "Sign out".
//
// The data panel is generic: the console passes `sections()` (title, rows,
// actions) and this file renders it with DOM calls, never innerHTML, so a room
// name or a script title can't inject markup.

const AUTH = "/_ay/auth";
const NAMES = { google: "Google", github: "GitHub" };

/** What the site offers: { available, providers, user }. Never throws. */
export async function loadAuthState(fetchImpl = fetch) {
  const none = { available: false, providers: [], user: null };
  try {
    const p = await fetchImpl(`${AUTH}/providers`, { credentials: "same-origin" });
    if (!p.ok || !(p.headers.get("content-type") || "").includes("json")) return none;
    const providers = ((await p.json()).providers || []).filter((x) => x in NAMES);
    if (!providers.length) return none;
    const s = await fetchImpl(`${AUTH}/get-session`, { credentials: "same-origin" });
    const body = s.ok ? await s.json().catch(() => null) : null;
    const u = body?.user;
    return {
      available: true,
      providers,
      user: u ? { name: u.name || "", email: u.email || "", image: u.image || "" } : null,
    };
  } catch {
    return none;
  }
}

/** What the button and menu show for an auth state, or null when nothing should show. */
export function profileView(state) {
  if (!state?.available) return null;
  if (!state.user)
    return {
      kind: "signed-out",
      label: "Sign in",
      signIn: state.providers.map((id) => ({ id, label: `Sign in with ${NAMES[id]}` })),
    };
  const { name, email } = state.user;
  return {
    kind: "signed-in",
    label: name || email,
    initial: (name || email || "?").trim().charAt(0).toUpperCase(),
    name,
    email,
  };
}

async function postJson(path, body) {
  const r = await fetch(AUTH + path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return r.json().catch(() => ({}));
}

export async function signInWith(provider, returnTo = location.pathname + location.search) {
  const r = await postJson("/sign-in/social", {
    provider,
    callbackURL: returnTo,
    errorCallbackURL: returnTo,
  });
  if (r?.url) location.href = r.url;
}

const css = `
.ayp{position:relative;display:inline-block;margin-left:8px;font:12px system-ui,sans-serif}
.ayp>button{font:inherit;cursor:pointer;color:var(--fg,#c9d1d9);background:var(--panel2,#1c2128);
 border:1px solid var(--line,#2d3748);border-radius:14px;padding:2px 9px;display:flex;gap:6px;align-items:center}
.ayp .av{width:18px;height:18px;border-radius:50%;background:var(--accent,#58a6ff);color:var(--bg,#0d1117);
 display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;overflow:hidden}
.aypm{position:absolute;right:0;top:calc(100% + 6px);z-index:2147483000;min-width:220px;max-width:92vw;
 background:var(--panel,#161b22);color:var(--fg,#c9d1d9);border:1px solid var(--line,#2d3748);
 border-radius:8px;padding:6px;box-shadow:0 8px 24px #0006}
.aypm .who{padding:6px 8px;border-bottom:1px solid var(--line,#2d3748);margin-bottom:4px}
.aypm .who b{display:block}.aypm .who span{color:var(--muted,#8b949e);word-break:break-all}
.aypm button{display:block;width:100%;text-align:left;font:inherit;color:inherit;background:none;
 border:0;border-radius:6px;padding:6px 8px;cursor:pointer}
.aypm button:hover{background:var(--panel2,#1c2128)}
.aypd{position:fixed;inset:0;z-index:2147483001;background:#0008;display:flex;align-items:center;
 justify-content:center;font:13px system-ui,sans-serif}
.aypd>div{background:var(--panel,#161b22);color:var(--fg,#c9d1d9);border:1px solid var(--line,#2d3748);
 border-radius:10px;width:min(720px,94vw);max-height:86vh;overflow:auto;padding:14px 16px}
.aypd h2{margin:0 0 4px;font-size:15px}.aypd h3{margin:14px 0 4px;font-size:12px;text-transform:uppercase;
 letter-spacing:.05em;color:var(--muted,#8b949e)}
.aypd .hint{color:var(--muted,#8b949e);font-size:12px;margin:0 0 6px}
.aypd .row{display:flex;gap:8px;align-items:center;padding:4px 2px;border-bottom:1px solid var(--line,#2d3748)}
.aypd .row .t{flex:1;font-family:var(--mono,monospace);word-break:break-all}
.aypd .row .s{color:var(--muted,#8b949e);font-size:11px}
.aypd .badge{font-size:11px;color:var(--muted,#8b949e);white-space:nowrap}
.aypd button{font:inherit;cursor:pointer;color:inherit;background:var(--panel2,#1c2128);
 border:1px solid var(--line,#2d3748);border-radius:6px;padding:2px 8px}
.aypd .empty{color:var(--muted,#8b949e);padding:4px 2px}
`;

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  const { onclick, ...rest } = props;
  Object.assign(e, rest);
  if (onclick) e.addEventListener("click", onclick);
  e.append(...kids.flat().filter((k) => k != null));
  return e;
}

function openDataPanel(sections, rerender) {
  const close = () => back.remove();
  const body = el("div", {});
  const back = el("div", { className: "aypd", onclick: (e) => e.target === back && close() }, body);
  const draw = () => {
    body.replaceChildren(
      el("h2", { textContent: "My data" }),
      el("p", {
        className: "hint",
        textContent:
          "Everything this console keeps for you. Only the rooms marked ☁ sync with your account; the rest lives on this device.",
      }),
      ...sections().map((sec) =>
        el(
          "div",
          {},
          el("h3", { textContent: sec.title }),
          sec.hint ? el("p", { className: "hint", textContent: sec.hint }) : null,
          sec.rows.length
            ? sec.rows.map((r) =>
                el(
                  "div",
                  { className: "row" },
                  el(
                    "span",
                    { className: "t" },
                    r.label,
                    r.sub ? el("div", { className: "s", textContent: r.sub }) : null,
                  ),
                  r.badge ? el("span", { className: "badge", textContent: r.badge }) : null,
                  (r.actions || []).map((a) =>
                    el("button", {
                      textContent: a.label,
                      title: a.title || "",
                      onclick: async () => {
                        await a.run();
                        draw();
                        rerender?.();
                      },
                    }),
                  ),
                ),
              )
            : el("div", { className: "empty", textContent: sec.empty || "nothing here" }),
          (sec.actions || []).map((a) =>
            el("button", {
              textContent: a.label,
              title: a.title || "",
              style: "margin-top:6px;margin-right:6px",
              onclick: async () => {
                await a.run();
                draw();
                rerender?.();
              },
            }),
          ),
        ),
      ),
      el(
        "div",
        { style: "margin-top:12px;text-align:right" },
        el("button", { textContent: "Close", onclick: close }),
      ),
    );
  };
  draw();
  document.body.append(back);
  return close;
}

/**
 * Mount the profile button into `host`. Does nothing (and leaves `host` empty)
 * where the site has no sign-in.
 *   sections()        data panel sections: [{title, hint?, rows:[{label, sub?, badge?,
 *                     actions?:[{label, run}]}], actions?:[{label, run}], empty?}]
 *   beforeSignOut()   resolves false to cancel (e.g. a confirm about synced rooms)
 *   signOut()         ends the session (and does the console's own clean-up)
 */
export async function mountProfile(host, { sections, beforeSignOut, signOut, rerender } = {}) {
  const state = await loadAuthState();
  const view = profileView(state);
  if (!view) return null;
  if (!document.getElementById("ayp-css"))
    document.head.append(el("style", { id: "ayp-css", textContent: css }));
  const root = el("span", { className: "ayp" });
  const menu = el("div", { className: "aypm" });
  menu.hidden = true;
  const toggle = el("button", {
    type: "button",
    title: view.kind === "signed-in" ? view.email : "Sign in (optional)",
  });
  const closeMenu = () => (menu.hidden = true);
  if (view.kind === "signed-in") {
    toggle.append(
      el(
        "span",
        { className: "av" },
        // An initial, not the provider's avatar: the CSP allows no remote images,
        // and fetching one would tell the provider every time the console opens.
        view.initial,
      ),
    );
    menu.append(
      el(
        "div",
        { className: "who" },
        el("b", { textContent: view.name || view.email }),
        el("span", { textContent: view.email }),
      ),
      el("button", {
        textContent: "My data…",
        onclick: () => (closeMenu(), openDataPanel(sections || (() => []), rerender)),
      }),
      el("button", {
        textContent: "Sign out",
        onclick: async () => {
          closeMenu();
          if ((await beforeSignOut?.()) === false) return;
          await (signOut ? signOut() : postJson("/sign-out"));
          location.reload();
        },
      }),
    );
  } else {
    toggle.append(view.label);
    for (const p of view.signIn)
      menu.append(
        el("button", { textContent: p.label, onclick: () => (closeMenu(), signInWith(p.id)) }),
      );
  }
  toggle.addEventListener("click", () => (menu.hidden = !menu.hidden));
  document.addEventListener("click", (e) => root.contains(e.target) || closeMenu());
  root.append(toggle, menu);
  host.append(root);
  return root;
}
